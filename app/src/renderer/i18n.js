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
    'nav.toggle': 'HIDE OR SHOW THE MENU',
    'tab.intel': 'INTEL',
    'view.photo': 'PHOTO',
    'view.received': 'RECEIVED',
    'view.share': 'SHARE',
    'tab.brief': 'BRIEF',
    'tab.received': 'RECEIVED',
    'tab.share': 'SHARE',
    'tab.card': 'CARD',
    'tab.setup': 'SETUP',
    // launcher group headings. Listed for every group the roadmap will add,
    // so a new page needs no new heading — GROUPS in viewer.js skips empties.
    'group.intel': 'INTEL',
    'group.mission': 'MISSION',
    'group.reference': 'REFERENCE',
    'group.tools': 'TOOLS',
    'group.system': 'SYSTEM',
    'strip.unnamed': 'UNNAMED',
    'strip.host': 'HOST · {n} ON NET',
    'strip.joined': 'JOINED',
    'strip.nonet': 'NO NET',
    'strip.online': 'ONLINE · {t}',
    'strip.offline': 'OFFLINE',

    // banner
    'banner.newFrom': 'NEW FROM {who}',
    'banner.switched': 'SWITCHED AUTOMATICALLY',
    'banner.queued': 'QUEUED',

    // stage / standby
    'stage.noIntel': 'NO INTEL',
    'standby.title': 'STANDBY',
    'standby.nothing': 'NO INTEL RECEIVED',
    'standby.sincePowerUp': 'SINCE POWER UP',
    'standby.offline': 'OFFLINE',

    // --- brief mode ---
    // Never "relay", never red: this is a live thing, not a fault.
    'brief.youArePresenting': 'YOU ARE PRESENTING',
    'brief.withYou': '{n} WITH YOU',
    'brief.stop': 'STOP',
    'brief.following': 'FOLLOWING {who}',
    'brief.heldByPresenter': 'YOUR CONTROLS ARE HELD UNTIL THEY STOP',
    'brief.notInYourBrief': 'THEY ARE ON A PHOTO YOU DO NOT HAVE',

    // Window controls. Icon-only, so these reach a pilot through aria-label
    // and the tooltip rather than as visible text — see applyStatic().
    'win.minimize': 'MINIMISE',
    'win.maximize': 'MAXIMISE',
    'win.close': 'CLOSE',
    // Kneeboard card. Block TITLES come from the card and are the author's
    // words — untouched. Only what the app itself says goes through here.
    'card.none': 'NO CARD LOADED',
    'card.rejected': 'CARD REFUSED — SEE LOG',
    'card.tick': 'MARK THIS STEP COMPLETE',


    // OpenKneeboard panel. The native path: OpenKneeboard renders the EFB
    // itself instead of capturing the window.
    'rail.kneeboard': 'KNEEBOARD',
    'cap.okb': 'OpenKneeboard tab',
    'okb.offer': 'OFFER A TAC LINK TAB TO OPENKNEEBOARD',
    'okb.stepFound': 'OPENKNEEBOARD',
    'okb.stepRegistered': 'PLUGIN',
    'okb.stepTab': 'TAB',
    'okb.onHint': 'OPENKNEEBOARD CAN DRAW THIS APP ITSELF',
    'okb.offHint': 'ONLY WINDOW CAPTURE',
    'okb.notWindows': 'WINDOWS ONLY',
    'okb.found': 'FOUND',
    'okb.notFound': 'NOT INSTALLED',
    'okb.offered': 'OFFERED',
    'okb.notOffered': 'NOT OFFERED',
    'okb.tabWaiting': 'ADD IT IN OPENKNEEBOARD',
    'okb.tabOpen': 'OPEN',
    'okb.addTab': 'RESTART OPENKNEEBOARD, THEN ADD A TAB \u2192 TAC LINK',
    'okb.stillCaptures': 'WINDOW CAPTURE KEEPS WORKING EITHER WAY',
    'brief.present': 'PRESENT',
    'brief.pen': 'PEN',
    'brief.arrow': 'ARROW',
    'brief.ring': 'RING',
    'brief.undo': 'UNDO',
    'brief.clear': 'CLEAR',

    // received
    'received.autoshow': 'SHOW NEW INTEL ON ARRIVAL',
    'received.autoshowHint': 'SWITCHES THE BRIEF FOR YOU · OFF = BANNER ONLY',
    'received.inBrief': '{sel} OF {n} IN BRIEF · {t}',
    'received.hide': 'HIDE',
    'received.restore': 'RESTORE',
    'received.emptyTitle': 'NOTHING RECEIVED YET',
    'received.emptyHint': 'ANYTHING THE SQUAD SHARES LANDS HERE',

    // share
    'share.count': '{sel} OF {n} · {size}',
    'share.noPhotos': 'NO PHOTOS',
    'share.notSet': 'NOT SET',
    'share.all': 'SELECT ALL',
    'share.none': 'DESELECT ALL',
    'share.folderBtn': 'FOLDER…',
    'share.reveal': 'REVEAL {photos}',
    'share.nothingSelected': 'NOTHING SELECTED',
    'photo.one': '{n} PHOTO',
    'photo.many': '{n} PHOTOS',

    // fault
    'fault.unknown': 'UNKNOWN',
    'net.fix': 'OFFLINE — OPEN NETWORK SETUP',

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
    'net.offline': 'OFFLINE',
    'cap.whereRelay': 'WHO HOSTS THE SQUAD?',
    'choice.host': 'I HOST THE SQUAD',
    'choice.hostHint': 'THIS MACHINE HOSTS — YOU HAND OUT THE CODE',
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
    'keys.passthrough': 'LET BOUND KEYS REACH OTHER APPS',
    'keys.passthroughOn': 'ANY KEY CAN BE BOUND · TYPING STILL WORKS',
    'keys.passthroughOff': 'KEYS ARE TAKEN EXCLUSIVELY · USE MODIFIERS',
    'keys.passthroughFailed': 'UNAVAILABLE ON THIS PC · USING EXCLUSIVE KEYS',
    'ts.actInstall': 'INSTALL TAILSCALE',
    'ts.actSignIn': 'SIGN IN TO TAILSCALE',
    'ts.actShare': 'SHARE OVER THE INTERNET',
    'ts.actStop': 'STOP SHARING',
    'ts.actEnable': 'ENABLE FUNNEL IN ADMIN',
    'ts.actRecheck': 'CHECK AGAIN',
    'ts.hintInstall': 'INSTALL IT, THEN COME BACK — THIS PANEL NOTICES ON ITS OWN',
    'ts.hintSignIn': 'OR SIGN IN FROM THE TAILSCALE TRAY ICON',
    'ts.hintShare': 'SQUAD MEMBERS OUTSIDE YOUR NETWORK NEED THIS',
    'ts.hintOn': 'YOUR SQUAD CODE REACHES YOU FROM ANYWHERE',
    'ts.hintEnable': 'ONE-TIME APPROVAL FOR YOUR TAILNET, THEN IT RETRIES',
    'ts.hintLocal': 'WITHOUT IT THE CODE ONLY WORKS ON YOUR LAN',

    // settings keybinds
    'cap.keybinds': 'GLOBAL KEYBINDS — THIS MACHINE',
    'bind.reveal': 'REVEAL',
    'bind.prev': 'PREVIOUS',
    'bind.next': 'NEXT',
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

    // main process (tray / app menu). Sentence case: these are OS chrome,
    // not the engraved cockpit labels the rest of the app uses.
    'menu.settings': 'Settings',
    'menu.quit': 'Quit',
    'menu.edit': 'Edit',
    'menu.undo': 'Undo',
    'menu.redo': 'Redo',
    'menu.cut': 'Cut',
    'menu.copy': 'Copy',
    'menu.paste': 'Paste',
    'menu.selectAll': 'Select All',
  };

  const it = {
    'nav.toggle': 'NASCONDI O MOSTRA IL MENU',
    'tab.intel': 'INTEL',
    'view.photo': 'FOTO',
    'view.received': 'RICEVUTE',
    'view.share': 'CONDIVIDI',
    'tab.brief': 'BRIEF',
    'tab.received': 'RICEVUTE',
    'tab.share': 'CONDIVIDI',
    'tab.card': 'CARD',
    'tab.setup': 'SETUP',
    'group.intel': 'INTEL',
    'group.mission': 'MISSIONE',
    'group.reference': 'RIFERIMENTI',
    'group.tools': 'STRUMENTI',
    'group.system': 'SISTEMA',
    'strip.unnamed': 'SENZA NOME',
    'strip.host': 'HOST · {n} IN RETE',
    'strip.joined': 'CONNESSO',
    'strip.nonet': 'SENZA RETE',
    'strip.online': 'ONLINE · {t}',
    'strip.offline': 'OFFLINE',

    'banner.newFrom': 'NUOVO DA {who}',
    'banner.switched': 'CAMBIO AUTOMATICO',
    'banner.queued': 'IN CODA',

    'stage.noIntel': 'NESSUN INTEL',
    'standby.title': 'STANDBY',
    'standby.nothing': 'NESSUN INTEL RICEVUTO',
    'standby.sincePowerUp': "DALL'ACCENSIONE",
    'standby.offline': 'OFFLINE',

    // --- brief mode ---
    'brief.youArePresenting': 'STAI PRESENTANDO',
    'brief.withYou': '{n} CON TE',
    'brief.stop': 'FERMA',
    'brief.following': 'SEGUI {who}',
    'brief.heldByPresenter': 'I TUOI COMANDI SONO BLOCCATI FINCHÉ NON SMETTE',
    'brief.notInYourBrief': 'SONO SU UNA FOTO CHE NON HAI',

    'rail.kneeboard': 'KNEEBOARD',
    'cap.okb': 'Scheda OpenKneeboard',
    'okb.offer': 'OFFRI UNA SCHEDA TAC LINK A OPENKNEEBOARD',
    'okb.stepFound': 'OPENKNEEBOARD',
    'okb.stepRegistered': 'PLUGIN',
    'okb.stepTab': 'SCHEDA',
    'okb.onHint': 'OPENKNEEBOARD PUO DISEGNARE QUESTA APP DA SE',
    'okb.offHint': 'SOLO CATTURA FINESTRA',
    'okb.notWindows': 'SOLO WINDOWS',
    'okb.found': 'TROVATO',
    'okb.notFound': 'NON INSTALLATO',
    'okb.offered': 'OFFERTO',
    'okb.notOffered': 'NON OFFERTO',
    'okb.tabWaiting': 'AGGIUNGILA IN OPENKNEEBOARD',
    'okb.tabOpen': 'APERTA',
    'okb.addTab': 'RIAVVIA OPENKNEEBOARD, POI AGGIUNGI UNA SCHEDA \u2192 TAC LINK',
    'okb.stillCaptures': 'LA CATTURA FINESTRA CONTINUA A FUNZIONARE',
    'win.minimize': 'RIDUCI A ICONA',
    'win.maximize': 'INGRANDISCI',
    'win.close': 'CHIUDI',
    'card.none': 'NESSUNA CARD CARICATA',
    'card.rejected': 'CARD RIFIUTATA — VEDI LOG',
    'card.tick': 'SEGNA QUESTO STEP COME FATTO',

    'brief.present': 'PRESENTA',
    'brief.pen': 'PENNA',
    'brief.arrow': 'FRECCIA',
    'brief.ring': 'CERCHIO',
    'brief.undo': 'ANNULLA',
    'brief.clear': 'CANCELLA',

    'received.autoshow': 'MOSTRA I NUOVI INTEL ALL’ARRIVO',
    'received.autoshowHint': 'CAMBIA IL BRIEF DA SOLO · OFF = SOLO BANNER',
    'received.inBrief': '{sel} DI {n} NEL BRIEF · {t}',
    'received.hide': 'NASCONDI',
    'received.restore': 'RIPRISTINA',
    'received.emptyTitle': 'ANCORA NESSUNA RICEZIONE',
    'received.emptyHint': 'CIÒ CHE LA SQUADRA INVIA ARRIVA QUI',

    'share.count': '{sel} DI {n} · {size}',
    'share.noPhotos': 'NESSUNA FOTO',
    'share.notSet': 'NON IMPOSTATA',
    'share.all': 'SELEZIONA TUTTO',
    'share.none': 'DESELEZIONA TUTTO',
    'share.folderBtn': 'CARTELLA…',
    'share.reveal': 'INVIA {photos}',
    'share.nothingSelected': 'NESSUNA SELEZIONE',
    'photo.one': '{n} FOTO',
    'photo.many': '{n} FOTO',

    'fault.unknown': 'SCONOSCIUTO',
    'net.fix': 'OFFLINE — APRI IMPOSTAZIONI RETE',

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
    'net.offline': 'OFFLINE',
    'cap.whereRelay': 'CHI OSPITA LA SQUADRA?',
    'choice.host': 'OSPITO IO LA SQUADRA',
    'choice.hostHint': 'OSPITA QUESTA MACCHINA — IL CODICE LO DISTRIBUISCI TU',
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
    'keys.passthrough': 'LASCIA PASSARE I TASTI ALLE ALTRE APP',
    'keys.passthroughOn': 'QUALSIASI TASTO · SCRIVERE FUNZIONA ANCORA',
    'keys.passthroughOff': 'TASTI PRESI IN ESCLUSIVA · USA I MODIFICATORI',
    'keys.passthroughFailed': 'NON DISPONIBILE SU QUESTO PC · TASTI ESCLUSIVI',
    'ts.actInstall': 'INSTALLA TAILSCALE',
    'ts.actSignIn': 'ACCEDI A TAILSCALE',
    'ts.actShare': 'CONDIVIDI SU INTERNET',
    'ts.actStop': 'INTERROMPI CONDIVISIONE',
    'ts.actEnable': 'ABILITA FUNNEL NELL’ADMIN',
    'ts.actRecheck': 'CONTROLLA DI NUOVO',
    'ts.hintInstall': 'INSTALLALO, POI TORNA QUI — IL PANNELLO SE NE ACCORGE DA SOLO',
    'ts.hintSignIn': 'OPPURE ACCEDI DALL’ICONA TAILSCALE NELLA BARRA',
    'ts.hintShare': 'SERVE A CHI È FUORI DALLA TUA RETE',
    'ts.hintOn': 'IL TUO CODICE SQUADRA TI RAGGIUNGE OVUNQUE',
    'ts.hintEnable': 'APPROVAZIONE UNA TANTUM PER LA TUA TAILNET, POI RIPROVA',
    'ts.hintLocal': 'SENZA, IL CODICE FUNZIONA SOLO NELLA TUA LAN',

    'cap.keybinds': 'COMANDI GLOBALI — QUESTA MACCHINA',
    'bind.reveal': 'INVIA',
    'bind.prev': 'PRECEDENTE',
    'bind.next': 'SUCCESSIVA',
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
    'menu.edit': 'Modifica',
    'menu.undo': 'Annulla',
    'menu.redo': 'Ripristina',
    'menu.cut': 'Taglia',
    'menu.copy': 'Copia',
    'menu.paste': 'Incolla',
    'menu.selectAll': 'Seleziona tutto',
  };

  const DICTS = { en, it };
  const DEFAULT_LOCALE = 'en';
  let current = DEFAULT_LOCALE;

  function setLocale(l) {
    current = DICTS[l] ? l : DEFAULT_LOCALE;
  }

  /**
   * Decides which language to show.
   *
   * `configured` wins when it names a locale we ship — that is the pilot
   * choosing explicitly in settings. Otherwise follow the OS: walk the
   * user's ORDERED preference list and take the first language we support.
   *
   * Two things this gets right that a one-liner does not:
   *
   *   1. It matches on the LANGUAGE SUBTAG only, never a substring. A Mac
   *      set to English in Italy reports "en-IT" — the "IT" is the region.
   *      `String(tag).includes('it')` would flip that machine to Italian.
   *   2. It respects preference ORDER. ["en-IT", "it-IT"] means "English
   *      first, Italian if you must" and must render English, even though
   *      Italian also appears.
   *
   * Anything unrecognised falls back to English.
   */
  function pickLocale(preferred, configured) {
    if (DICTS[configured]) return configured;
    for (const tag of Array.isArray(preferred) ? preferred : []) {
      const language = String(tag || '')
        .toLowerCase()
        .split(/[-_]/)[0];
      if (DICTS[language]) return language;
    }
    return DEFAULT_LOCALE;
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
    // Icon-only controls carry their name in aria-label instead: writing it as
    // textContent would print the word next to the glyph. A separate attribute
    // rather than a smarter [data-i18n] rule, because textContent is the whole
    // reason [data-i18n] must sit on a leaf element and that trap is not worth
    // making subtler.
    for (const node of root.querySelectorAll('[data-i18n-aria]')) {
      node.setAttribute('aria-label', t(node.dataset.i18nAria));
      node.setAttribute('title', t(node.dataset.i18nAria));
    }
  }

  return { t, photos, setLocale, locale, applyStatic, pickLocale, DICTS, DEFAULT_LOCALE };
});
