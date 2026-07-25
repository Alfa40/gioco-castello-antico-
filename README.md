# Quartiere Ostile

Un piccolo beat 'em up top-down giocabile nel browser, in HTML/CSS/JavaScript puro (nessuna build, nessuna dipendenza).

Sei un ragazzo qualunque che vive in un quartiere difficile. Ogni notte dei criminali di strada provano ad assaltarti per portarti via i tuoi soldi. Difenditi, mettili K.O. e usa i guadagni per rinforzare casa tua. Più ti addentri nel quartiere, più gli aggressori diventano numerosi, veloci e aggressivi.

## Come giocare

Apri `index.html` in un browser (o servilo con un semplice server statico, es. `python3 -m http.server`), poi premi **Entra nel quartiere**.

- **WASD / Frecce** — Movimento (determina anche la direzione dell'attacco in mischia)
- **Spazio** — Attacca in mischia (colpisce i nemici a distanza ravvicinata attorno a te)
- **F** — Spara manualmente con l'arma a distanza, se ne possiedi una
- **Shift** — Scatto/schivata (breve invulnerabilità)
- **U** / **Esc** — Pausa e menu potenziamenti casa

Con un'arma a distanza equipaggiata, il personaggio spara **anche in automatico**, senza bisogno di premere nulla, non appena la mira è puntata su un nemico a portata (come nei giochi mobile). Da tastiera la mira segue semplicemente la direzione in cui ti muovi.

### Controller (es. DualShock 4 via Bluetooth)

Il gioco usa la Gamepad API del browser: nessuna configurazione richiesta, basta abbinare il controller via Bluetooth nel sistema operativo, aprire la pagina e **premere un tasto sul controller** (i browser espongono il gamepad solo dopo una prima pressione, per motivi di privacy). Lo stato della connessione compare nella schermata iniziale.

- **Levetta sinistra / D-pad** — Movimento
- **Levetta destra** — Mira, indipendente dal movimento (torna a seguire il movimento quando la lasci al centro)
- **✕ (Cross)** — Attacca in mischia
- **R2** — Spara manualmente (in aggiunta allo sparo automatico quando la mira è su un nemico)
- **○ (Circle)** — Scatto/schivata
- **Options** — Pausa e menu potenziamenti casa

L'acquisto di potenziamenti/armi nel negozio richiede ancora mouse o tastiera: il controller copre il gameplay in tempo reale, non la navigazione dei menu.

## Il loop di gioco

- Sconfiggi i nemici di ogni zona per guadagnare soldi.
- Se un nemico ti colpisce, oltre al danno rischia di rubarti una parte dei soldi guadagnati.
- Al termine di ogni zona apri il menu **Potenzia casa** e spendi i soldi guadagnati in:
  - **Potenziamenti casa**: danno, velocità, difesa, vita massima, protezione dai furti, recupero HP tra una zona e l'altra.
  - **Armi da mischia**: una progressione sequenziale (Pugni → Coltello → Coltello a serramanico → Mazza da baseball → Palo d'acciaio). I coltelli colpiscono più forte e più in fretta, mazza e palo colpiscono più lontano ma più lentamente. Ogni acquisto sostituisce l'arma precedente.
  - **Armi a distanza**: uno slot separato e opzionale (tasto F), sbloccato solo dopo aver raggiunto una certa zona in questa run (Pistola dalla zona 3, Mitra dalla zona 5). Hanno un caricatore limitato: le munizioni si esauriscono sparando e vanno rifornite uccidendo nemici (drop casuale) o comprandole nel negozio di fine zona.
- I nemici sconfitti lasciano a volte un **medikit** (cura una parte della vita massima) o, se hai un'arma a distanza, delle **munizioni**: bastano un attimo di calpestio per raccoglierli.
- Completata una zona, ti addentri ancora di più nel quartiere: i nemici della zona successiva sono più numerosi, e cambia anche il loro mix di comportamento:
  - **Balordo** — lento e prevedibile, ti insegue in modo diretto.
  - **Nervoso** — veloce, ti insegue quasi in linea retta e attacca con cadenza molto più rapida.
  - **Imprevedibile** (dalla zona 3) — movimenti a scatti, non ti insegue sempre: a volte carica, a volte scarta di lato, a volte si allontana.
- **Ogni run riparte da zero.** Non c'è alcun progresso permanente tra una partita e l'altra: soldi, potenziamenti, armi e munizioni esistono solo per la partita in corso. Se vieni sopraffatto, la prossima partita ricomincia da zona 1 con 0 soldi, i pugni nudi e nessun potenziamento — l'unico modo per "fare progressi" è arrivare più in profondità nella stessa run.

## Struttura del progetto

- `index.html` — markup e overlay dell'interfaccia (menu, HUD, schermata potenziamenti, game over)
- `style.css` — tema visivo
- `script.js` — tutta la logica di gioco (player, nemici, spawn/scaling delle zone, potenziamenti, armi, pickup)
