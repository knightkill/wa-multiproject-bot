// Normalize a participant identifier into a WhatsApp user JID.
//
// Accepts either an explicit JID (must already be a person @s.whatsapp.net
// or LID @lid; the domain is lowercased) or a bare phone number, which is
// stripped to digits and turned into <digits>@s.whatsapp.net. Throws on
// anything that can't be coerced into a valid user JID so callers can map
// the failure to a 400.
export function toUserJid(input) {
  const trimmed = String(input).trim();
  if (trimmed.includes('@')) {
    const at = trimmed.indexOf('@');
    const local = trimmed.slice(0, at);
    const domain = trimmed.slice(at + 1).toLowerCase();
    if ((domain !== 's.whatsapp.net' && domain !== 'lid') || !/^\d+$/.test(local)) {
      throw new Error('invalid participant JID: ' + input);
    }
    return `${local}@${domain}`;
  }
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) {
    throw new Error('invalid phone number: ' + input);
  }
  return digits + '@s.whatsapp.net';
}
