# Crazy Town

Un piccolo beat 'em up top-down giocabile nel browser, in HTML/CSS/JavaScript puro (nessuna build, nessuna dipendenza), con supporto opzionale per giocare in due in co-op online.

Sei un ragazzo qualunque che vive in un quartiere difficile. Ogni notte dei criminali di strada provano ad assaltarti per portarti via i tuoi soldi. Difenditi, mettili K.O. e usa i guadagni per rinforzare casa tua. Più ti addentri nel quartiere, più gli aggressori diventano numerosi, veloci e aggressivi.

## Come giocare

Apri `index.html` in un browser (o servilo con un semplice server statico, es. `python3 -m http.server`), poi premi **Entra nel quartiere**. Questo copre l'esperienza da un giocatore solo; per giocare in due vedi [Multiplayer](#multiplayer-co-op-online) qui sotto, che invece richiede il piccolo server Node incluso nel progetto.

- **WASD / Frecce** — Movimento (determina anche la direzione dell'attacco in mischia)
- **Spazio** — Attacca in mischia (colpisce i nemici a distanza ravvicinata attorno a te)
- **F** — Spara manualmente con l'arma a distanza, se ne possiedi una
- **Shift** — Scatto/schivata (breve invulnerabilità)
- **1-7** — Seleziona l'esplosivo da lanciare
- **G** — Lancia l'esplosivo selezionato
- **U** / **Esc** — Pausa e menu potenziamenti casa

Con un'arma a distanza equipaggiata, il personaggio spara **anche in automatico**, senza bisogno di premere nulla, non appena la mira è puntata su un nemico a portata (come nei giochi mobile). Da tastiera la mira segue semplicemente la direzione in cui ti muovi.

### Controller (es. DualShock 4 via Bluetooth)

Il gioco usa la Gamepad API del browser: nessuna configurazione richiesta, basta abbinare il controller via Bluetooth nel sistema operativo, aprire la pagina e **premere un tasto sul controller** (i browser espongono il gamepad solo dopo una prima pressione, per motivi di privacy). Lo stato della connessione compare nella schermata iniziale.

- **Levetta sinistra / D-pad** — Movimento
- **Levetta destra** — Mira, indipendente dal movimento (torna a seguire il movimento quando la lasci al centro)
- **✕ (Cross)** — Attacca in mischia
- **R2** — Spara manualmente (in aggiunta allo sparo automatico quando la mira è su un nemico)
- **○ (Circle)** — Scatto/schivata
- **L1** — Seleziona l'esplosivo da lanciare
- **R1** — Lancia l'esplosivo selezionato
- **Options** — Pausa e menu potenziamenti casa

L'acquisto di potenziamenti/armi nel negozio richiede ancora mouse o tastiera: il controller copre il gameplay in tempo reale, non la navigazione dei menu.

### Telefono / tablet

Il campo di gioco resta sempre orizzontale, senza bisogno di ruotare il telefono: se lo tieni in verticale, testo (vita, zona, ecc.) e comandi si dispongono rispettivamente sopra e sotto al campo; in orizzontale si dividono ai due lati — in entrambi i casi restano sempre fuori dal campo di gioco stesso, che resta pulito. La schermata si adatta automaticamente a qualsiasi dimensione dello schermo. I controlli touch (grandi, per essere facili da premere) compaiono solo su dispositivi con schermo touch:

- **Levetta virtuale sinistra** — Movimento
- **Levetta virtuale destra** — Mira, indipendente dal movimento (esattamente come la levetta destra del controller): serve a puntare l'arma a distanza dove vuoi, a prescindere da dove ti stai muovendo
- **Fulmine** — Scatto/schivata
- **Bomba** — Lancia l'esplosivo selezionato
- **Freccette circolari** — Cambia l'esplosivo selezionato
- **⏸** — Pausa e menu potenziamenti casa

Su telefono sia l'attacco in mischia (colpisce tutto ciò che è a portata intorno a te, in qualsiasi direzione) che quello a distanza (quando la mira è su un nemico a portata) sono **automatici**: niente tasto pugno né tasto spara manuale, per evitare confusione con l'automatico. La levetta destra serve solo a puntare l'arma a distanza dove vuoi, e torna a seguire la direzione in cui ti muovi se la lasci al centro.

## Multiplayer (co-op online)

Fino a **quattro giocatori** possono giocare **la stessa partita insieme**, in tempo reale, condividendo soldi e potenziamenti nella stessa "casa". Funziona così:

- Uno dei quattro fa da **host**: gira davvero la simulazione di gioco (nemici, danni, economia) per tutti i personaggi, esattamente come farebbe in singolo.
- Gli altri (fino a tre) si **uniscono con un codice** e diventano **ospiti**: il loro browser non calcola nulla della partita, invia solo i propri comandi (movimento, mira, attacco, scatto, esplosivi) e riceve dall'host lo stato aggiornato del campo da disegnare a schermo.
- I nemici prendono di mira automaticamente chiunque tra i giocatori attivi sia più vicino; tutti condividono soldi, potenziamenti casa e armi acquistate (gli ospiti non gestiscono direttamente il negozio: solo l'host può aprire pausa/potenzia casa, gli ospiti in quel momento vedono semplicemente "in attesa").
- Se un ospite si disconnette la partita continua senza interruzioni per tutti gli altri; se è l'host a disconnettersi, la sessione di ogni ospite termina (non avendo mai calcolato nulla in locale) e torna al menu.

**Requisito importante:** questa modalità richiede un piccolo server Node in esecuzione — non funziona aprendo semplicemente `index.html` da un hosting statico come GitHub Pages, perché serve un endpoint WebSocket per far incontrare i giocatori. Il server (`server.js`) non contiene alcuna logica di gioco: fa solo da "centralino" che smista i messaggi tra i browser connessi alla stessa stanza (il file system statico del gioco viene comunque servito dallo stesso processo, per comodità).

Per avviarlo:

```bash
npm install
npm start
```

Poi apri `http://localhost:8080` (o l'indirizzo/porta del server, se ospitato altrove) nei browser che vogliono giocare insieme:

1. Il primo giocatore preme **Crea stanza** nella sezione "Multiplayer (co-op)" della schermata iniziale: ottiene un codice a 4 cifre da condividere.
2. Gli altri (fino a tre) inseriscono quel codice e premono **Unisciti**.
3. Una volta connessi, l'host preme **Entra nel quartiere** (o **Continua partita**) come al solito: la partita inizia per tutti.

Ci si può unire anche a partita già iniziata (l'host può creare la stanza e giocare da solo finché gli altri non si collegano, uno alla volta, fino al limite di 4). La sincronizzazione avviene circa 20 volte al secondo: su una connessione con latenza alta il movimento degli altri giocatori può risultare leggermente meno fluido del proprio, essendo un aggiornamento periodico e non un movimento predetto localmente.

### Ospitarlo online gratis (per giocare con amici non sulla stessa rete)

`npm start` in locale funziona solo tra dispositivi sulla stessa rete (o dietro un tunnel tipo `cloudflared`/ngrok). Per un indirizzo pubblico fisso, sempre raggiungibile, il repo include un `render.yaml` pronto per [Render](https://render.com) (piano gratuito):

1. Crea un account su render.com (anche via GitHub).
2. **New → Blueprint**, collega questo repository: Render legge da solo `render.yaml` e propone build/start command già corretti — basta confermare.
3. Deploy: dopo qualche minuto ottieni un indirizzo tipo `https://crazy-town.onrender.com`, che serve l'intero gioco (singolo e multiplayer) da un unico processo.

Limite del piano gratuito: il servizio si addormenta dopo ~15 minuti di inattività e la prima richiesta successiva impiega 30-60 secondi a risvegliarlo — basta aprire il link un attimo prima di iniziare a giocare.

## Il loop di gioco

- Sconfiggi i nemici di ogni zona per guadagnare soldi.
- Se un nemico ti colpisce, oltre al danno rischia di rubarti una parte dei soldi guadagnati.
- Al termine di ogni zona apri il menu **Potenzia casa**: si apre sempre su una schermata principale con le statistiche della run (zona raggiunta, nemici sconfitti, soldi guadagnati, arma con più uccisioni), con dei pulsanti in alto che aprono una sezione alla volta (come una tendina) invece di un'unica lista lunga da scorrere. Le sezioni permettono di spendere i soldi guadagnati in:
  - **Potenziamenti casa**: danno, velocità, difesa, vita massima, protezione dai furti, recupero HP tra una zona e l'altra, scorta massima di esplosivi, tempo di recupero dello scatto, bonus soldi guadagnati, durata dell'invulnerabilità dopo un colpo, velocità degli attacchi in mischia.
  - **Armi da mischia**: una progressione sequenziale (Pugni → Coltello → Coltello a serramanico → Mazza da baseball → Palo d'acciaio → Martello). I coltelli colpiscono più forte e più in fretta, mazza/palo/martello colpiscono più lontano e più forte ma più lentamente. Ogni tier (tranne i pugni) ha **5 potenziamenti specifici** (impugnatura, lama, contrappeso, rinforzi, portata) che vanno comprati tutti prima di poter passare all'arma successiva — restano comunque sempre più deboli dell'arma seguente presa di base.
  - **Armi a distanza**: uno slot separato e opzionale (tasto F), sbloccato solo dopo aver raggiunto una certa zona in questa run (Pistola dalla zona 12, Mitra dalla zona 20, Cecchino dalla zona 28, Shotgun dalla zona 36, Lanciarazzi dalla zona 44). Anche queste hanno **5 potenziamenti dedicati** (mirino, calcio, canna, caricatore, canna rigata) da completare prima di passare all'arma successiva. Lo shotgun spara più pallini in un cono stretto, il lanciarazzi fa danno ad area su tutti i nemici colpiti dall'esplosione. Hanno un caricatore limitato: le munizioni si esauriscono sparando e vanno rifornite uccidendo nemici (drop casuale) o comprandole nel negozio di fine zona.
  - **Esplosivi**: granate, molotov, bombe adesive, granate fumogene/stordenti, coltelli da lancio e shuriken, acquistabili a pile (fino a un massimo a testa, aumentabile con "Zaino esplosivi"). Si lanciano nella direzione della mira (tasto **G** / **R1**), con selezione tramite tasti **1-7** o **L1**.
    - **Granata** (75px di raggio) infligge un danno calcolato in base alla zona: uccide sempre i nemici "base" in un colpo solo, ma non basta mai per il Bruto.
    - **Molotov** (100px di raggio) lascia una pozza di fuoco che brucia per 5 secondi chiunque ci passi sopra.
    - **Bomba adesiva** si attacca al primo nemico colpito ed esplode con un danno enorme.
    - **Granata fumogena** (150px di raggio) acceca i nemici nella nube: chi non è a un passo (10px) da un giocatore vaga a caso invece di inseguire.
    - **Granata stordente** (75px di raggio) blocca ogni movimento dei nemici vicini per 2,5 secondi.
    - **Coltello da lancio** vola dritto e uccide all'istante il primo nemico che colpisce, qualunque sia la sua vita residua.
    - **Shuriken** vola veloce e insegue leggermente il nemico più vicino alla sua traiettoria, utile contro un bersaglio isolato che si muove.
- I nemici sconfitti lasciano a volte un **medikit** (cura una parte della vita massima) o, se hai un'arma a distanza, delle **munizioni**: bastano un attimo di calpestio per raccoglierli.
- Completata una zona, ti addentri ancora di più nel quartiere: i nemici della zona successiva sono più numerosi, e cambia anche il loro mix di comportamento:
  - **Balordo** — lento e prevedibile, ti insegue in modo diretto.
  - **Nervoso** — veloce, ti insegue quasi in linea retta e attacca con cadenza molto più rapida.
  - **Imprevedibile** (dalla zona 3) — movimenti a scatti, non ti insegue sempre: a volte carica, a volte scarta di lato, a volte si allontana.
  - **Bruto** (dalla zona 4) — lentissimo, ma incassare un suo colpo fa malissimo.
  - **Tiratore** (dalla zona 5) — mantiene le distanze e spara proiettili invece di attaccare in mischia; fragile se riesci ad avvicinarti.
  - **Quelli del drive by** (dalla zona 6) — sfrecciano dentro e fuori dal campo in linea retta sparando contro il player; non attaccano in mischia e non ti inseguono. Se riesci ad abbatterli prima che escano dal campo pagano molto di più del normale.
- Oltre alla zona, anche il tuo "livello" (quanti potenziamenti/armi hai comprato in questa run) fa lentamente crescere vita e danno dei nemici: comprare tutto non rende la run banale.
- **Ogni run riparte da zero se vieni sopraffatto.** Non c'è alcun progresso permanente tra una partita e l'altra: se muori, la prossima partita ricomincia da zona 1 con 0 soldi, i pugni nudi e nessun potenziamento — l'unico modo per "fare progressi" è arrivare più in profondità nella stessa run.
- **La partita in corso però si salva da sola.** Ogni volta che apri il menu potenziamenti (pausa o fine zona) lo stato viene salvato nel browser: puoi chiudere la pagina e riprendere più tardi dalla schermata iniziale con **Continua partita**, senza perdere soldi, potenziamenti e armi. Solo la sconfitta cancella il salvataggio.

## Struttura del progetto

- `index.html` — markup e overlay dell'interfaccia (menu, HUD, schermata potenziamenti, game over)
- `style.css` — tema visivo
- `script.js` — tutta la logica di gioco (player, nemici, spawn/scaling delle zone, potenziamenti, armi, pickup, multiplayer)
- `server.js` — server Node opzionale: file statici + relay WebSocket per il multiplayer (nessuna logica di gioco)
- `package.json` — dipendenza `ws` del server
