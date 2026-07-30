'use strict';

// All user-facing strings, in English and Italian. UMD like format.js: the
// renderers load it as a plain <script>, plain node requires it for
// dev-i18n-test, and the MAIN process requires it too for the tray and menu.
//
// Rules:
// - Keys are stable ids; a missing key renders AS the key, which is the
//   visible canary for an untranslated string.
// - {name} placeholders, replaced by t(key, vars).
// - Static chrome is marked data-i18n="key" in the HTML on LEAF elements
//   only (applyStatic writes textContent, which would erase children).
// - Console/log lines are NOT here and stay English: they are diagnostics,
//   grepped by tests and pasted into bug reports.
// - Deliberate anglicisms in Italian: cockpit/product vocabulary that an
//   Italian squadron actually uses stays English — BRIEF, STANDBY, HOST,
//   RELAY, FUNNEL, TOKEN, SETUP, LOG, CALLSIGN would be over-translation.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.I18n = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const en = {
    // viewer chrome
    'tab.brief': 'BRIEF',
    'tab.received': 'RECEIVED',
    'tab.share': 'SHARE',
    'tab.setup': 'SETUP',
    'strip.unnamed': 'UNNAMED',
    'strip.host': 'HOST · {n} ON NET',
    'strip.joined': 'JOINED',
    'strip.nonet': 'NO NET',
    'strip.relayUp': 'RELAY UP · {t}',
    'strip.relayDown': 'RELAY DOWN',

    // banner
    'banner.newFrom': 'NEW FROM {who}',
    'banner.switched': 'SWITCHED AUTOMATICALLY',
    'banner.queued': 'QUEUED',

    // stage / standby
    'stage.noIntel': 'NO INTEL',
    'standby.title': 'STANDBY',
    'standby.nothing': 'NO INTEL RECEIVED',
    'standby.sincePowerUp': 'SINCE POWER UP',
    'standby.relayDown': 'RELAY DOWN',

    // received
    'received.autoshow': 'SHOW NEW INTEL ON ARRIVAL',
    'received.autoshowHint': 'SWITCHES THE BRIEF FOR YOU · OFF = BANNER ONLY',
    'received.inBrief': '{sel} OF {n} IN BRIEF · {t}',
    'received.hide': 'HIDE',
    'received.restore': 'RESTORE',
    'received.emptyTitle': 'NOTHING RECEIVED YET',
    'received.emptyHint': 'ANYTHING THE SQUAD SHARES LANDS HERE',

    // share
    'cap.folder': 'FOLDER',
    'cap.selected': 'SELECTED',
    'share.count': '{sel} OF {n} · {size}',
    'share.noPhotos': 'NO PHOTOS',
    'share.notSet': 'NOT SET',
    'share.all': 'SELECT ALL',
    'share.none': 'NONE',
    'share.rescan': 'RESCAN',
    'share.folderBtn': 'FOLDER…',
    'share.reveal': 'REVEAL {photos}',
    'share.nothingSelected': 'NOTHING SELECTED',
    'photo.one': '{n} PHOTO',
    'photo.many': '{n} PHOTOS',

    // fault
    'fault.title': 'RELAY LOST',
    'fault.reconnecting': 'RECONNECTING',
    'fault.attempt': 'ATTEMPT {n} · NEXT IN {s}S',
    'cap.lastContact': 'LAST CONTACT',
    'cap.relay': 'RELAY',
    'fault.unknown': 'UNKNOWN',
    'cap.offline': 'STILL AVAILABLE OFFLINE',
    'fault.cached': '{batches} BATCHES · {photos} PHOTOS',
    'fault.offlineHint': 'BROWSE AND SHARE STILL WORK',
    'fault.retry': 'RETRY NOW',
    'fault.openSetup': 'OPEN SETUP',

    // settings rail
    'rail.network': 'NETWORK',
    'rail.keybinds': 'KEYBINDS',
    'rail.log': 'LOG',
    'cap.language': 'LANGUAGE',

    // settings network
    'cap.callsign': 'CALLSIGN — HOW THE SQUAD SEES YOU',
    'net.hosting': 'HOSTING',
    'net.joined': 'JOINED',
    'net.notConnected': 'NOT CONNECTED',
    'net.hostingMeta': '{n} ON NET · {funnel}',
    'net.funnelUp': 'FUNNEL UP · {t}',
    'net.funnelDown': 'FUNNEL DOWN',
    'net.pasteToJoin': 'PASTE A CODE TO JOIN',
    'net.relayDown': 'RELAY DOWN',
    'cap.whereRelay': 'WHERE IS THE RELAY?',
    'choice.host': 'I HOST THE SQUAD',
    'choice.hostHint': 'THIS MACHINE RUNS THE RELAY — YOU HAND OUT THE CODE',
    'choice.join': 'I JOIN A SQUAD',
    'choice.joinHint': 'SOMEONE ELSE HOSTS — PASTE THE CODE THEY SENT YOU',
    'cap.squadCode': 'YOUR SQUAD CODE — TREAT IT AS A PASSWORD',
    'net.codeUnavailable': 'NOT AVAILABLE',
    'net.copyCode': 'COPY SQUAD CODE',
    'cap.internetLink': 'INTERNET LINK — VIA TAILSCALE',
    'cap.port': 'PORT',
    'cap.token': 'TOKEN',
    'net.newToken': 'NEW TOKEN — INVALIDATES EVERY CODE',
    'step.pasteCode': 'PASTE THE SQUAD CODE',
    'net.paste': 'PASTE',
    'step.connect': 'CONNECT',
    'net.connect': 'CONNECT',
    'net.pasteToConnect': 'PASTE A CODE TO CONNECT',
    'net.badCode': 'CODE NOT RECOGNISED',
    'net.resolved': '{host} · PORT {port} · TOKEN VALID',
    'net.codeCarries': 'THE CODE CARRIES HOST, PORT AND TOKEN',
    'net.nothingElse': 'NOTHING ELSE TO TYPE',
    'cap.pilots': 'PILOTS ON NET —',
    'net.nobodyElse': 'NOBODY ELSE ON NET',
    'net.you': 'YOU',
    'net.host': 'HOST',
    // tailscale steps
    'ts.installed': 'INSTALLED',
    'ts.notFound': 'NOT FOUND · CLICK TO INSTALL',
    'ts.waiting': 'WAITING',
    'ts.signInRequired': 'SIGN IN REQUIRED',
    'ts.signedIn': 'SIGNED IN',
    'ts.upCodeReady': 'UP · CODE READY',
    'ts.up': 'UP',
    'ts.needsEnabling': 'NEEDS ENABLING IN ADMIN',
    'ts.failed': 'FAILED · SEE LOG',
    'ts.off': 'OFF',

    // settings keybinds
    'cap.keybinds': 'GLOBAL KEYBINDS — THIS MACHINE',
    'bind.reveal': 'REVEAL',
    'bind.prev': 'PREVIOUS',
    'bind.next': 'NEXT',
    'bind.hide': 'HIDE CHROME',
    'bind.settings': 'OPEN SETUP',
    'bind.record': 'RECORD',
    'bind.stop': 'STOP',
    'bind.pressKeys': 'PRESS KEYS…',
    'bind.oneOwner': 'ONE APP OWNS A GLOBAL KEY AT A TIME',

    // settings log
    'cap.version': 'VERSION',
    'cap.sent': 'SENT',
    'cap.received': 'RECEIVED',
    'cap.drops': 'DROPS',
    'cap.logFile': 'LOG FILE',
    'log.open': 'OPEN LOG',
    'log.copyPath': 'COPY PATH',
    'cap.lastEvents': 'LAST EVENTS',

    // savebar
    'save.applied': 'ALL CHANGES APPLIED',
    'save.unsaved': 'UNSAVED CHANGES',
    'save.cta': 'SAVE & APPLY',

    // main process (tray / app menu)
    'menu.settings': 'Settings',
    'menu.quit': 'Quit',
  };

  const it = {
    'tab.brief': 'BRIEF',
    'tab.received': 'RICEVUTE',
    'tab.share': 'CONDIVIDI',
    'tab.setup': 'SETUP',
    'strip.unnamed': 'SENZA NOME',
    'strip.host': 'HOST · {n} IN RETE',
    'strip.joined': 'CONNESSO',
    'strip.nonet': 'SENZA RETE',
    'strip.relayUp': 'RELAY UP · {t}',
    'strip.relayDown': 'RELAY GIÙ',

    'banner.newFrom': 'NUOVO DA {who}',
    'banner.switched': 'CAMBIO AUTOMATICO',
    'banner.queued': 'IN CODA',

    'stage.noIntel': 'NESSUN INTEL',
    'standby.title': 'STANDBY',
    'standby.nothing': 'NESSUN INTEL RICEVUTO',
    'standby.sincePowerUp': "DALL'ACCENSIONE",
    'standby.relayDown': 'RELAY GIÙ',

    'received.autoshow': 'MOSTRA I NUOVI INTEL ALL’ARRIVO',
    'received.autoshowHint': 'CAMBIA IL BRIEF DA SOLO · OFF = SOLO BANNER',
    'received.inBrief': '{sel} DI {n} NEL BRIEF · {t}',
    'received.hide': 'NASCONDI',
    'received.restore': 'RIPRISTINA',
    'received.emptyTitle': 'ANCORA NESSUNA RICEZIONE',
    'received.emptyHint': 'CIÒ CHE LA SQUADRA INVIA ARRIVA QUI',

    'cap.folder': 'CARTELLA',
    'cap.selected': 'SELEZIONATE',
    'share.count': '{sel} DI {n} · {size}',
    'share.noPhotos': 'NESSUNA FOTO',
    'share.notSet': 'NON IMPOSTATA',
    'share.all': 'TUTTE',
    'share.none': 'NESSUNA',
    'share.rescan': 'AGGIORNA',
    'share.folderBtn': 'CARTELLA…',
    'share.reveal': 'INVIA {photos}',
    'share.nothingSelected': 'NESSUNA SELEZIONE',
    'photo.one': '{n} FOTO',
    'photo.many': '{n} FOTO',

    'fault.title': 'RELAY PERSO',
    'fault.reconnecting': 'RICONNESSIONE',
    'fault.attempt': 'TENTATIVO {n} · TRA {s}S',
    'cap.lastContact': 'ULTIMO CONTATTO',
    'cap.relay': 'RELAY',
    'fault.unknown': 'SCONOSCIUTO',
    'cap.offline': 'ANCORA DISPONIBILE OFFLINE',
    'fault.cached': '{batches} BATCH · {photos} FOTO',
    'fault.offlineHint': 'SFOGLIARE E INVIARE FUNZIONANO ANCORA',
    'fault.retry': 'RIPROVA ORA',
    'fault.openSetup': 'APRI SETUP',

    'rail.network': 'RETE',
    'rail.keybinds': 'COMANDI',
    'rail.log': 'LOG',
    'cap.language': 'LINGUA',

    'cap.callsign': 'CALLSIGN — COME TI VEDE LA SQUADRA',
    'net.hosting': 'HOSTING',
    'net.joined': 'CONNESSO',
    'net.notConnected': 'NON CONNESSO',
    'net.hostingMeta': '{n} IN RETE · {funnel}',
    'net.funnelUp': 'FUNNEL UP · {t}',
    'net.funnelDown': 'FUNNEL DOWN',
    'net.pasteToJoin': 'INCOLLA UN CODICE PER UNIRTI',
    'net.relayDown': 'RELAY GIÙ',
    'cap.whereRelay': 'DOV’È IL RELAY?',
    'choice.host': 'OSPITO IO LA SQUADRA',
    'choice.hostHint': 'QUESTA MACCHINA ESEGUE IL RELAY — IL CODICE LO DISTRIBUISCI TU',
    'choice.join': 'MI UNISCO A UNA SQUADRA',
    'choice.joinHint': 'OSPITA QUALCUN ALTRO — INCOLLA IL CODICE CHE TI HA INVIATO',
    'cap.squadCode': 'IL TUO CODICE SQUADRA — TRATTALO COME UNA PASSWORD',
    'net.codeUnavailable': 'NON DISPONIBILE',
    'net.copyCode': 'COPIA CODICE SQUADRA',
    'cap.internetLink': 'COLLEGAMENTO INTERNET — VIA TAILSCALE',
    'cap.port': 'PORTA',
    'cap.token': 'TOKEN',
    'net.newToken': 'NUOVO TOKEN — INVALIDA OGNI CODICE',
    'step.pasteCode': 'INCOLLA IL CODICE SQUADRA',
    'net.paste': 'INCOLLA',
    'step.connect': 'CONNETTI',
    'net.connect': 'CONNETTI',
    'net.pasteToConnect': 'INCOLLA UN CODICE PER CONNETTERE',
    'net.badCode': 'CODICE NON RICONOSCIUTO',
    'net.resolved': '{host} · PORTA {port} · TOKEN VALIDO',
    'net.codeCarries': 'IL CODICE CONTIENE HOST, PORTA E TOKEN',
    'net.nothingElse': 'NIENT’ALTRO DA DIGITARE',
    'cap.pilots': 'PILOTI IN RETE —',
    'net.nobodyElse': 'NESSUN ALTRO IN RETE',
    'net.you': 'TU',
    'net.host': 'HOST',
    'ts.installed': 'INSTALLATO',
    'ts.notFound': 'NON TROVATO · CLICCA PER INSTALLARE',
    'ts.waiting': 'IN ATTESA',
    'ts.signInRequired': 'ACCESSO RICHIESTO',
    'ts.signedIn': 'CONNESSO',
    'ts.upCodeReady': 'SU · CODICE PRONTO',
    'ts.up': 'SU',
    'ts.needsEnabling': 'DA ABILITARE NELL’ADMIN',
    'ts.failed': 'FALLITO · VEDI LOG',
    'ts.off': 'SPENTO',

    'cap.keybinds': 'COMANDI GLOBALI — QUESTA MACCHINA',
    'bind.reveal': 'INVIA',
    'bind.prev': 'PRECEDENTE',
    'bind.next': 'SUCCESSIVA',
    'bind.hide': 'NASCONDI INTERFACCIA',
    'bind.settings': 'APRI SETUP',
    'bind.record': 'REGISTRA',
    'bind.stop': 'STOP',
    'bind.pressKeys': 'PREMI I TASTI…',
    'bind.oneOwner': 'UNA SOLA APP POSSIEDE UN TASTO GLOBALE ALLA VOLTA',

    'cap.version': 'VERSIONE',
    'cap.sent': 'INVIATI',
    'cap.received': 'RICEVUTI',
    'cap.drops': 'PERSI',
    'cap.logFile': 'FILE DI LOG',
    'log.open': 'APRI LOG',
    'log.copyPath': 'COPIA PERCORSO',
    'cap.lastEvents': 'ULTIMI EVENTI',

    'save.applied': 'TUTTO APPLICATO',
    'save.unsaved': 'MODIFICHE NON SALVATE',
    'save.cta': 'SALVA E APPLICA',

    'menu.settings': 'Impostazioni',
    'menu.quit': 'Esci',
  };

  const DICTS = { en, it };
  let current = 'en';

  function setLocale(l) {
    current = DICTS[l] ? l : 'en';
  }
  function locale() {
    return current;
  }
  /** Missing key renders as the key itself — the visible canary. */
  function t(key, vars) {
    let s = DICTS[current][key];
    if (s === undefined) s = DICTS.en[key];
    if (s === undefined) return key;
    if (vars) for (const k of Object.keys(vars)) s = s.split(`{${k}}`).join(String(vars[k]));
    return s;
  }
  /** Locale-aware photo count: "3 PHOTOS" / "3 FOTO". */
  function photos(n) {
    return t(n === 1 ? 'photo.one' : 'photo.many', { n });
  }
  /** Writes every [data-i18n] leaf in root. Leaf elements only. */
  function applyStatic(root) {
    for (const node of root.querySelectorAll('[data-i18n]')) {
      node.textContent = t(node.dataset.i18n);
    }
  }

  return { t, photos, setLocale, locale, applyStatic, DICTS };
});
