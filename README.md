# Quartiere Ostile

Un piccolo beat 'em up top-down giocabile nel browser, in HTML/CSS/JavaScript puro (nessuna build, nessuna dipendenza).

Sei un ragazzo qualunque che vive in un quartiere difficile. Ogni notte dei criminali di strada provano ad assaltarti per portarti via i tuoi soldi. Difenditi, mettili K.O. e usa i guadagni per rinforzare casa tua. Più ti addentri nel quartiere, più gli aggressori diventano numerosi, veloci e aggressivi.

## Come giocare

Apri `index.html` in un browser (o servilo con un semplice server statico, es. `python3 -m http.server`), poi premi **Entra nel quartiere**.

- **WASD / Frecce** — Movimento (determina anche la direzione dell'attacco/dello sparo)
- **Spazio** — Attacca in mischia (colpisce i nemici a distanza ravvicinata attorno a te)
- **F** — Spara con l'arma a distanza, se ne possiedi una
- **Shift** — Scatto/schivata (breve invulnerabilità)
- **U** / **Esc** — Pausa e menu potenziamenti casa

## Il loop di gioco

- Sconfiggi i nemici di ogni zona per guadagnare soldi.
- Se un nemico ti colpisce, oltre al danno rischia di rubarti una parte dei soldi guadagnati.
- Al termine di ogni zona apri il menu **Potenzia casa** e spendi i risparmi in:
  - **Potenziamenti casa**: danno, velocità, difesa, vita massima, protezione dai furti, recupero HP tra una zona e l'altra.
  - **Armi da mischia**: una progressione sequenziale (Pugni → Coltello → Coltello a serramanico → Mazza da baseball → Palo d'acciaio). I coltelli colpiscono più forte e più in fretta, mazza e palo colpiscono più lontano ma più lentamente. Ogni acquisto sostituisce l'arma precedente.
  - **Armi a distanza**: uno slot separato e opzionale (tasto F), sbloccato solo dopo aver raggiunto una certa zona almeno una volta (Pistola dalla zona 3, Mitra dalla zona 5).
- Completata una zona, ti addentri ancora di più nel quartiere: i nemici della zona successiva sono più numerosi, e cambia anche il loro mix di comportamento:
  - **Balordo** — lento e prevedibile, ti insegue in modo diretto.
  - **Nervoso** — veloce, ti insegue quasi in linea retta e attacca con cadenza molto più rapida.
  - **Imprevedibile** (dalla zona 3) — movimenti a scatti, non ti insegue sempre: a volte carica, a volte scarta di lato, a volte si allontana.
- Se vieni sopraffatto la run finisce, ma i soldi guadagnati, i potenziamenti e le armi sbloccate restano salvati (nel `localStorage` del browser) per il tentativo successivo.

## Struttura del progetto

- `index.html` — markup e overlay dell'interfaccia (menu, HUD, schermata potenziamenti, game over)
- `style.css` — tema visivo
- `script.js` — tutta la logica di gioco (player, nemici, spawn/scaling delle zone, potenziamenti, salvataggio)
