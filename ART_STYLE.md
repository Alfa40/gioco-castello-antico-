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

## 3. Convenzioni di naming file

- Personaggi: `assets/characters/[nome-personaggio].png`
- Armi: `assets/weapons/[nome-arma].png`
- Usare sempre trattini (`-`) al posto di spazi, tutto minuscolo

Esempi:
- `assets/characters/criminale.png`
- `assets/characters/tossicodipendente.png`
- `assets/weapons/mazza-baseball.png`
- `assets/weapons/lanciarazzi.png`

---

## 4. Istruzioni per Claude Code

Quando viene richiesta la generazione di un nuovo asset (personaggio o arma):

1. Identificare se si tratta di un personaggio o di un'arma
2. Prendere il prompt base + negative prompt corrispondente da questo file
3. Se l'asset è già presente nella lista sopra, usare la descrizione già definita
4. Se è un asset nuovo, generare una [DESCRIZIONE SPECIFICA] coerente con lo stile degli esempi esistenti (stessa struttura: acconciatura/dettaglio distintivo + abbigliamento + oggetti in mano)
5. Chiamare il tool MCP di Leonardo AI con il prompt completo (base + descrizione specifica) e il negative prompt
6. Salvare il file generato nella cartella corretta seguendo le convenzioni di naming
7. Se richiesto, integrare l'asset nel codice del gioco (es. riferimento nello script del personaggio/arma)
8. Aggiungere la nuova voce a questo file, così lo stile resta documentato e riutilizzabile per le generazioni future
