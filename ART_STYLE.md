# Linee guida grafiche del gioco

Questo documento definisce lo stile visivo standard di tutti gli asset del gioco (personaggi, armi, oggetti). Va usato come riferimento ogni volta che si genera un nuovo asset tramite Leonardo AI (MCP), in modo da garantire coerenza visiva in tutto il progetto senza dover riscrivere i prompt manualmente ogni volta.

---

## Stile generale

- **Prospettiva:** Top-down, camera perfettamente perpendicolare al terreno, che punta dritto verso il basso (bird's-eye view)
- **Stile artistico:** Pixel art retrò, 32-bit
- **Sfondo:** Nero pieno (#000000), isolato, da rimuovere in post-produzione se necessario
- **Aspect ratio:** 1:1 (quadrato), risoluzione output consigliata 1024x1024
- **Palette colori:** Limitata, coerente tra tutti gli asset
- **Bordi:** Pixel puliti, nessun antialiasing eccessivo

---

## 1. PERSONAGGI

### Prompt base (personaggi)
```
Top-down pixel art game character viewed from directly above (bird's-eye view, camera perfectly perpendicular to the ground, looking straight down at the top of the character's head), 32-bit retro pixel art style, only the top/back of the head and both hands/forearms are visible, arms extending outward to the left and right as if reaching forward from below the frame, [DESCRIZIONE SPECIFICA], character centered in frame, isolated on solid black background, no face visible, no body visible, clean pixel edges, limited color palette, soft ambient shading on hair, symmetrical composition, consistent pixel art game style matching other character sprites, game asset sprite, high detail pixel work, square aspect ratio 1:1
```

### Negative prompt (personaggi)
```
face, eyes, nose, mouth, front view, side view, full body, legs, feet, torso, background details, scenery, blurry, photorealistic, 3D render, low quality, extra limbs, distorted hands, watermark, text, signature
```

### Esempi di [DESCRIZIONE SPECIFICA] già definiti

**Criminale/rapinatore:**
```
shaved head with a scar visible, wearing a black hoodie, holding a crowbar in the left hand and a ski mask in the right hand, tattoos visible on forearms
```

**Spacciatore:**
```
slicked back dark hair, wearing a gold chain and a leather jacket, holding a small plastic bag of pills in one hand and a wad of cash in the other hand
```

**Tossicodipendente:**
```
messy unwashed brown hair, dirty ragged clothes, holding a syringe in one hand and a lighter in the other hand, grimy skin texture on forearms
```

**Barbone:**
```
long unkempt gray hair and beard stubble visible on jaw, wearing a torn oversized coat, holding a tattered blanket in one hand and an empty bottle in the other hand
```

**Teppista/bullo di strada:**
```
short spiky bleached hair, wearing a ripped denim vest, holding a baseball bat in one hand and brass knuckles in the other hand
```

**Borseggiatore:**
```
hair hidden under a dark beanie, wearing fingerless gloves, holding a stolen wallet in one hand and a knife in the other hand
```

---

## 2. ARMI

Le armi devono sempre sembrare impugnate da qualcuno e puntare dritte in avanti, viste dall'alto, senza mai mostrare il braccio: solo la mano.

### Prompt base (armi)
```
Top-down pixel art game weapon viewed from directly above (bird's-eye view, camera perfectly perpendicular to the ground), 32-bit retro pixel art style, weapon held by a hand only (wrist and forearm not visible, cropped out of frame), hand entering the frame from the bottom edge, weapon pointing straight upward/forward away from the hand, [DESCRIZIONE SPECIFICA], centered in frame, isolated on solid black background, no face visible, no body visible, no arm visible, clean pixel edges, limited color palette, consistent pixel art game style matching character sprites, game asset sprite, high detail pixel work, square aspect ratio 1:1
```

### Negative prompt (armi)
```
face, eyes, nose, mouth, front view, side view, full body, legs, feet, torso, arm, forearm, elbow, background details, scenery, blurry, photorealistic, 3D render, low quality, extra limbs, distorted hands, watermark, text, signature, sideways weapon, weapon pointing downward
```

### Elenco armi definite ([DESCRIZIONE SPECIFICA])

**Pugni:**
```
bare clenched fist, no weapon, knuckles visible, hand tensed as if ready to strike, wrist cropped out of frame
```

**Coltello:**
```
single hand gripping a straight combat knife, blade pointing forward, metallic blade with slight shine, dark handle
```

**Coltello a serramanico:**
```
single hand gripping an open switchblade knife, thin curved blade pointing forward, sleek dark handle with a small button detail
```

**Mazza da baseball:**
```
two hands gripping a wooden baseball bat close together on the handle, bat pointing straight forward, visible wood grain texture, worn grip tape near the handle, wrists cropped out of frame
```

**Palo d'acciaio:**
```
two hands gripping a long steel pipe close together, pipe pointing straight forward, metallic gray texture with slight rust spots, wrists cropped out of frame
```

**Martello:**
```
single hand gripping a claw hammer, hammer head pointing forward, wooden handle, metallic hammer head with slight shine
```

**Pistola:**
```
single hand gripping a compact handgun, barrel pointing straight forward, dark metallic finish, small details like trigger guard visible
```

**Mitra:**
```
two hands gripping a submachine gun (one on the grip, one on the foregrip), barrel pointing straight forward, magazine visible beneath the grip, tactical dark metallic finish, wrists cropped out of frame
```

**Cecchino:**
```
two hands gripping a long sniper rifle (one on the grip, one on the foregrip), elongated barrel pointing straight forward, scope mounted on top, matte dark green and black finish, wrists cropped out of frame
```

**Shotgun:**
```
two hands gripping a pump-action shotgun (one on the grip, one on the pump), short wide barrel pointing straight forward, wooden stock details, dark metallic pump visible, wrists cropped out of frame
```

**Lanciarazzi:**
```
two hands gripping a large rocket launcher tube (one on the front grip, one on the rear grip), tube pointing straight forward, wide cylindrical shape, olive green military finish, visible front opening, wrists cropped out of frame
```

---

## 3. OGGETTI (parco)

Oggetti d'ambiente sparsi nel campo di gioco (ora sempre ambientato in un parco): fanno da ostacolo fisico finché non vengono distrutti a forza di colpirli. Ogni oggetto ha **5 immagini**, una per fase di danno — dalla condizione intatta a quella prossima alla distruzione — selezionate a runtime in base alla vita residua dell'oggetto.

A differenza di personaggi e armi, un oggetto non è mai impugnato né mostra mani/braccia: è ripreso da solo, isolato, visto dall'alto.

### Prompt base (oggetti)
```
Top-down pixel art game environmental object/prop viewed from directly above (bird's-eye view, camera perfectly perpendicular to the ground), 32-bit retro pixel art style, [DESCRIZIONE SPECIFICA], [FASE DANNO], object centered in frame, isolated on solid black background, no hands, no arms, no people visible, clean pixel edges, limited color palette, soft ambient shading, consistent pixel art game style matching other object sprites, game asset sprite, high detail pixel work, square aspect ratio 1:1
```

### Negative prompt (oggetti)
```
face, eyes, hands, arms, fingers, people, characters, front view, side view, background details, scenery, blurry, photorealistic, 3D render, low quality, watermark, text, signature
```

### Fasi di danno ([FASE DANNO])

Da inserire nel prompt insieme alla descrizione specifica dell'oggetto, così ogni oggetto ha la sua sequenza di 5 immagini via via più rovinate.

**Regola fondamentale:** le 5 fasi devono restare **lo stesso identico oggetto** — stesso colore, stessa forma/silhouette, stessa inquadratura/angolazione dall'alto. Cambia solo quanto appare rovinato (crepe, ammaccature, macchie di ruggine, vernice scrostata), mai il design dell'oggetto. Generazioni indipendenti tendono a "reinterpretare" colore e forma ad ogni fase — per questo, oltre alla frase di fase danno, ogni prompt deve includere ESPLICITAMENTE il colore/materiale esatto dell'oggetto (preso dalla descrizione specifica, es. "dark navy blue plastic body") e la frase di blocco qui sotto. Quando possibile, generare le fasi 2-5 in image-to-image usando la fase 1 come immagine di riferimento (guidance/influenza moderata), non da zero via solo testo.

Frase di blocco da aggiungere a ogni fase (dalla 2 in poi): `identical shape, silhouette, proportions, camera angle and base color to the undamaged version of this object — do not redesign it, do not change its color, do not open or rotate it, add ONLY surface damage`

1. **Intatto:** `in pristine, undamaged condition, clean and intact`
2. **Leggero danno:** `with minor scuffs, small scratches and light dirt, slightly worn but mostly intact, identical shape, silhouette, proportions, camera angle and base color to the undamaged version of this object — do not redesign it, do not change its color, do not open or rotate it, add ONLY surface damage`
3. **Danneggiato:** `visibly damaged with dents, scratches and rust spots, starting to look beaten down, identical shape, silhouette, proportions, camera angle and base color to the undamaged version of this object — do not redesign it, do not change its color, do not open or rotate it, add ONLY surface damage`
4. **Molto danneggiato:** `heavily damaged, large dents, cracks and rust, parts bent but still attached, close to falling apart, identical shape, silhouette, proportions, camera angle and base color to the undamaged version of this object — do not redesign it, do not change its color, do not open or rotate it, add ONLY surface damage`
5. **Quasi distrutto:** `nearly destroyed, crumbling wreck, broken and battered almost beyond recognition, barely holding together, but still recognizably the same object, identical shape, silhouette, proportions, camera angle and base color to the undamaged version of this object — do not redesign it, do not change its color, do not open or rotate it, add ONLY surface damage`

### Elenco oggetti definiti ([DESCRIZIONE SPECIFICA])

**Cestino della spazzatura:**
```
a park trash bin, dark green perforated metal mesh body, small round opening on top, mounted on a short brown wooden post, straight top-down view with no perspective tilt
```

**Panchina:**
```
a park bench, warm brown wooden slats on a dark metal frame, viewed from directly above showing the seat and backrest as two horizontal slat rows, straight top-down view with no perspective tilt
```

**Cassonetto:**
```
a large dark navy blue plastic garbage dumpster with wheels, hinged flat lid on top (closed), municipal waste bin, straight top-down view with no perspective tilt
```

**Barile:**
```
a weathered blue-gray metal oil drum/barrel, seen from directly above showing only the round top lid with visible rim ridges, industrial look, straight top-down view with no perspective tilt
```

**Recinzione di legno:**
```
a short section of wooden picket fence, warm brown wood, exactly 4 vertical wooden posts connected by horizontal rails, straight top-down view with no perspective tilt
```

**Albero:**
```
a park tree seen from directly above, round vibrant green leafy canopy, brown trunk barely visible at the very center, straight top-down view with no perspective tilt
```

**Lampione:**
```
a park street lamp post seen from directly above, circular light fixture with a warm golden yellow glow, dark metal rim, thin pole barely visible at the center, straight top-down view with no perspective tilt
```

---

## 4. SFONDO PARCO E SENTIERO

A differenza di personaggi/armi/oggetti, questi NON vanno isolati su sfondo nero: sono texture a piena inquadratura che coprono l'intero campo (sfondo) o una striscia ripetuta orizzontalmente (sentiero). Il campo è sempre un prato di parco; il sentiero è la corsia su cui passa l'auto del drive-by (vedi `Simulation.generateParkLayout`).

### Prompt base (sfondo parco)
```
Top-down pixel art game background texture, aerial view of a park lawn viewed from directly above (bird's-eye view, camera perfectly perpendicular to the ground), 32-bit retro pixel art style, [DESCRIZIONE SPECIFICA], grass texture filling the entire frame edge-to-edge with subtle tone variation, no objects, no people, no paths, no borders, no vignette, consistent pixel art game style, game background asset, high detail pixel work, square aspect ratio 1:1
```

### Negative prompt (sfondo parco)
```
people, characters, hands, objects, benches, trees, paths, roads, text, watermark, signature, blurry, photorealistic, 3D render, low quality, border, frame, vignette, black background
```

### 5 varianti ([DESCRIZIONE SPECIFICA])

Cambiano leggermente colore erba e/o aggiungono dettagli intangibili (mai ostacoli reali — solo decorazione, il gioco non li tratta come oggetti collidibili):

1. **Base:** `lush green grass with small dirt patches and scattered leaves`
2. **Erba più chiara:** `bright yellow-green grass, sun-bleached patches, a few small wildflowers`
3. **Con laghetto:** `deep green grass with a small round pond of blue water in one corner, reeds along its edge`
4. **Erba autunnale:** `deep green grass covered with scattered orange and brown fallen leaves`
5. **Erba serale:** `cool bluish-green grass with faint long shadows, a couple of small flower patches`

### Prompt base (sentiero)
```
Top-down pixel art game background texture, a paved park walkway viewed from directly above (bird's-eye view, camera perfectly perpendicular to the ground), 32-bit retro pixel art style, light gray stone pavement with subtle tile seams and weathering, straight horizontal strip filling the entire frame edge-to-edge, no grass, no objects, no people, no borders, no vignette, consistent pixel art game style, game background asset, high detail pixel work, square aspect ratio 1:1
```

### Negative prompt (sentiero)
```
people, characters, hands, objects, grass, vehicles, text, watermark, signature, blurry, photorealistic, 3D render, low quality, border, frame, vignette, black background
```

---

## 5. Convenzioni di naming file

- Personaggi: `generated-images/pixel/[nome-personaggio].png`
- Armi: `generated-images/pixel/weapon_[nome-arma].png`
- Oggetti: `generated-images/pixel/object_[nome-oggetto]_[fase 1-5].png`
- Sfondo parco: `generated-images/pixel/park_bg_[1-5].png`
- Sentiero: `generated-images/pixel/park_path.png`
- Usare sempre trattini (`-`) per i nomi composti, underscore per separare le parti del filename, tutto minuscolo

Esempi:
- `generated-images/pixel/enemy_tossicodipendente.png`
- `generated-images/pixel/weapon_mazza-baseball.png`
- `generated-images/pixel/object_panchina_1.png` … `object_panchina_5.png`
- `generated-images/pixel/object_albero_1.png` … `object_albero_5.png`
- `generated-images/pixel/park_bg_1.png` … `park_bg_5.png`
- `generated-images/pixel/park_path.png`

---

## 6. Istruzioni per Claude Code

Quando viene richiesta la generazione di un nuovo asset (personaggio, arma, oggetto, sfondo parco o sentiero):

1. Identificare la categoria (personaggio / arma / oggetto / sfondo parco / sentiero)
2. Prendere il prompt base + negative prompt corrispondente da questo file
3. Se l'asset è già presente nella lista sopra, usare la descrizione già definita (per gli oggetti: generare tutte e 5 le fasi di danno; per lo sfondo: tutte e 5 le varianti)
4. Se è un asset nuovo, generare una [DESCRIZIONE SPECIFICA] coerente con lo stile degli esempi esistenti della stessa categoria
5. Generare l'immagine con lo strumento disponibile (Leonardo AI se configurato, altrimenti il generatore immagini disponibile in sessione) con il prompt completo (base + descrizione specifica [+ fase danno per gli oggetti]) e il negative prompt
6. Salvare il file generato nella cartella corretta seguendo le convenzioni di naming
7. Se richiesto, integrare l'asset nel codice del gioco (es. riferimento nello script del personaggio/arma/oggetto/sfondo)
8. Aggiungere la nuova voce a questo file, così lo stile resta documentato e riutilizzabile per le generazioni future
