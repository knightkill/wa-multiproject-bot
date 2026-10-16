import { parsePhoneNumberFromString } from 'libphonenumber-js';

// Contact names come from three places, most trusted first: the operator's
// own WhatsApp address book (app-state sync), their Google Contacts (pushed
// in by an Apps Script), and the name a person set on their own profile
// (pushName). Each is stored in its own column; this picks one at read time.
export function displayName(row) {
  if (!row) return null;
  if (row.wa_name) return { name: row.wa_name, source: 'whatsapp' };
  if (row.google_name) return { name: row.google_name, source: 'google' };
  if (row.push_name) return { name: row.push_name, source: 'pushname' };
  return null;
}

// `123:4@s.whatsapp.net` (a device JID) → `123@s.whatsapp.net`. Returns null
// for anything that is not a person (groups, broadcast, newsletters).
export function userJid(jid) {
  const m = /^(\d+)(?::\d+)?@(s\.whatsapp\.net|c\.us|lid)$/.exec(String(jid ?? '').trim());
  if (!m) return null;
  return `${m[1]}@${m[2] === 'lid' ? 'lid' : 's.whatsapp.net'}`;
}

export function isLid(jid) {
  return typeof jid === 'string' && jid.endsWith('@lid');
}

// A phone number as typed into Google Contacts → a WhatsApp user JID, or null.
// Numbers without a country code are read as Indian. A bare international
// number missing its "+" (e.g. 61469132160) parses as an invalid Indian one,
// so that case is retried with a "+" in front.
export function phoneToJid(raw, defaultCountry = 'IN') {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  let parsed = parsePhoneNumberFromString(text, defaultCountry);
  if (!parsed?.isValid() && !text.startsWith('+')) {
    const retry = parsePhoneNumberFromString('+' + text.replace(/\D/g, ''));
    if (retry?.isValid()) parsed = retry;
  }
  if (!parsed?.isPossible()) return null;
  return `${parsed.number.slice(1)}@s.whatsapp.net`;
}

// Collapse a Google snapshot to one entry per WhatsApp JID. Google holds many
// duplicates (same number saved twice, sometimes spelt differently): the most
// recently updated entry gives the name, the other spellings become aliases
// so a search still finds them.
export function collapseGoogle(entries) {
  const byJid = new Map();
  let skipped = 0;
  for (const entry of entries) {
    const name = String(entry.name ?? '').trim();
    if (!name) continue;
    const updatedAt = Date.parse(entry.updatedAt ?? '') || 0;
    for (const phone of entry.phones ?? []) {
      const jid = phoneToJid(phone);
      if (!jid) {
        skipped++;
        continue;
      }
      const list = byJid.get(jid) ?? [];
      list.push({ name, updatedAt });
      byJid.set(jid, list);
    }
  }
  const out = new Map();
  for (const [jid, list] of byJid) {
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    const primary = list[0].name;
    const seen = new Set([primary.toLowerCase()]);
    const aliases = [];
    for (const { name } of list) {
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      aliases.push(name);
    }
    out.set(jid, { name: primary, aliases });
  }
  return { contacts: out, skipped };
}

// Wire Baileys contact/LID events into the contacts store. Kept separate from
// index.js so the mapping rules can be tested without a socket.
export function captureContacts(db, contacts, log) {
  for (const c of contacts ?? []) {
    try {
      const id = userJid(c?.id);
      if (!id) continue;
      const lid = isLid(id) ? id : userJid(c.lid);
      const pn = isLid(id) ? userJid(c.phoneNumber) : id;
      if (lid && isLid(lid) && pn && !isLid(pn)) db.setLidMapping(lid, pn);
      const fields = {};
      if (typeof c.name === 'string' && c.name.trim()) fields.waName = c.name.trim();
      if (typeof c.notify === 'string' && c.notify.trim()) fields.pushName = c.notify.trim();
      if (fields.waName || fields.pushName) db.upsertWaContact(pn ?? id, fields);
    } catch (err) {
      log?.warn({ err: String(err?.message ?? err), id: c?.id }, 'contact capture failed');
    }
  }
}

export function captureLidMappings(db, mappings, log) {
  for (const m of [].concat(mappings ?? [])) {
    const lid = userJid(m?.lid);
    const pn = userJid(m?.pn);
    if (!lid || !pn || !isLid(lid) || isLid(pn)) continue;
    try {
      db.setLidMapping(lid, pn);
    } catch (err) {
      log?.warn({ err: String(err?.message ?? err), lid }, 'lid mapping capture failed');
    }
  }
}

// Messages from Baileys 7 carry the sender in one addressing mode and its
// alternate (LID ↔ phone number) beside it; each pair is a free mapping.
export function lidPairsFromKey(key) {
  const pairs = [];
  for (const [a, b] of [[key?.remoteJid, key?.remoteJidAlt], [key?.participant, key?.participantAlt]]) {
    const x = userJid(a);
    const y = userJid(b);
    if (!x || !y) continue;
    if (isLid(x) && !isLid(y)) pairs.push({ lid: x, pn: y });
    else if (isLid(y) && !isLid(x)) pairs.push({ lid: y, pn: x });
  }
  return pairs;
}
