// Pushes this Google account's contacts (names + phone numbers) to the bot as
// a full snapshot: PUT <BOT_URL>/contacts/google. Runs on an hourly trigger.
//
// Script properties (Project Settings → Script properties):
//   BOT_URL              e.g. https://wp.hardip.me  (or .../a/<account>)
//   CONTACTS_PUSH_TOKEN  the bot's CONTACTS_PUSH_TOKEN secret
//
// Only "Contacts" are read, not "Other contacts" (Gmail's auto-saved,
// mostly email-only addresses).

function pushContacts() {
  const props = PropertiesService.getScriptProperties();
  const botUrl = props.getProperty('BOT_URL');
  const token = props.getProperty('CONTACTS_PUSH_TOKEN');
  if (!botUrl || !token) throw new Error('Set BOT_URL and CONTACTS_PUSH_TOKEN in Script properties');

  const contacts = [];
  let pageToken;
  do {
    const page = People.People.Connections.list('people/me', {
      personFields: 'names,phoneNumbers,metadata',
      pageSize: 1000,
      pageToken: pageToken,
    });
    for (const person of page.connections || []) {
      const phones = (person.phoneNumbers || []).map((p) => p.canonicalForm || p.value).filter(Boolean);
      const name = person.names && person.names[0] && person.names[0].displayName;
      if (!name || phones.length === 0) continue;
      const updatedAt = ((person.metadata && person.metadata.sources) || [])
        .map((s) => s.updateTime)
        .filter(Boolean)
        .sort()
        .pop();
      contacts.push({ name: name, phones: phones, updatedAt: updatedAt });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  const res = UrlFetchApp.fetch(botUrl.replace(/\/$/, '') + '/contacts/google', {
    method: 'put',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ contacts: contacts }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code !== 200) throw new Error('Bot answered ' + code + ': ' + res.getContentText().slice(0, 500));
  console.log(res.getContentText());
}

// Run once by hand to schedule pushContacts hourly (replaces any old trigger).
function installTrigger() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'pushContacts') ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger('pushContacts').timeBased().everyHours(1).create();
}
