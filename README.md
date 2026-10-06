# 🛡️ PoliMi Webex Enhancer
### *Strumenti avanzati per lo studio, trascrizione AI e visione offline delle lezioni*

![PoliMi Webex Enhancer](images/logo_full.png)

Estensione per Google Chrome pensata specificamente per gli studenti del **Politecnico di Milano**. Aggiunge strumenti dedicati per seguire le lezioni registrate su **Cisco Webex**, permettendo lo studio intensivo, la trascrizione automatica dell'audio con intelligenza artificiale e la visione **completamente offline senza connessione internet**.

---

## 🚀 Funzionalità Principali

### 🎙️ Trascrizione Automatica & Sottotitoli Sincronizzati (Whisper AI)
Uno dei punti di forza dell'estensione è la capacità di trascrivere automaticamente l'audio della lezione in pochi secondi direttamente nel browser:
* **Trascrizione ultra-veloce**: Utilizza il modello Whisper appoggiandosi alle API gratuite di Groq Cloud (elabora ore di lezione in pochissimi istanti).
* **Esportazione per l'Intelligenza Artificiale**: Puoi esportare la trascrizione completa dell'intera lezione con relativi timestamp (in formato testo o Markdown) con un solo clic. Questo ti consente di **dare in pasto il testo a modelli AI esterni** (come ChatGPT, Claude, Gemini o NotebookLM) per:
  * Generare riassunti dettagliati capitolo per capitolo.
  * Estrarre formulari, definizioni ed elenchi di teoremi d'esame.
  * Creare flashcard per Anki o domande di autoverifica.
  * Chiedere spiegazioni approfondite su passaggi specifici spiegati a voce dal professore.
* **Sottotitoli dinamici a schermo**: Mostra a video i sottotitoli sincronizzati riga per riga con la voce del docente.
* **Ricerca istantanea nel testo**: Barra di ricerca per trovare in tempo reale ogni punto della lezione in cui il docente ha pronunciato una determinata parola chiave o argomento.
* **Navigazione con un clic**: Cliccando su qualunque parola o frase della trascrizione, il video salta direttamente al secondo corrispondente.

---

### 📚 Player Offline Integrato e Gestione della Libreria
L'estensione include un **Player Offline completo e indipendente**, sviluppato per consentire lo studio anche in treno, aule studio senza Wi-Fi o in mobilità:
* **Libreria locale delle lezioni**: Un pannello dedicato che mostra tutte le lezioni salvate in memoria locale con data, durata e dimensione. Puoi aprire istantaneamente qualsiasi lezione già memorizzata oppure cancellarla per liberare spazio sul disco.
* **Accesso immediato senza rete**:
  * *Dall'icona dell'estensione*: Clicca sul pulsante **"📂 Apri Player Offline"** nel menu in alto a destra di Chrome.
  * *Dai Segnalibri (1 Clic)*: Salva la pagina del player nei Preferiti con `Ctrl + D` per aprirla direttamente in qualsiasi momento, anche a computer appena avviato senza connessione attiva.
* **Motore di Remuxing Anti-Desync Integrato**: I video scaricati vengono convertiti localmente in background applicando l'ottimizzazione dell'indice MP4 (`+faststart`). Questo elimina alla radice qualsiasi problema di desincronizzazione tra traccia audio e video durante i salti temporali (+10s, −30s, o clic sulla barra di avanzamento).
* **Sincronizzazione di note e trascrizioni**: Nel player offline ritrovi automaticamente tutte le trascrizioni AI generate, i sottotitoli e gli appunti presi per quella lezione.

---

### 🎛️ Barra di Studio e Controlli Avanzati
Sotto al video viene posizionata una **Barra di Studio** modulare e personalizzata con tutti gli strumenti essenziali:

* **Controlli Nativi Estesi**:
  * Pulsanti rapidi **−30s** e **+30s** posizionati subito accanto ai comandi standard del player.
  * Menu di velocità rapido (0.80x, 0.90x, 1.0x, 1.10x, 1.25x, 1.50x, 1.75x, 2.0x).
  * **Audio Boost fino al 300%**: Slider dedicato a tutta larghezza per amplificare il volume dei docenti registrati con microfono basso o distante.
* **🤫 Salto Automatico dei Silenzi**:
  * Algoritmo avanzato con 3 slider di precisione (velocità durante il silenzio fino a 3.5x, soglia di volume in decibel e tempo di riattacco).
  * Accelera automaticamente quando il professore scrive alla lavagna in silenzio e torna alla velocità normale non appena riprende a parlare, evitando di perdere l'inizio delle parole.
* **🔍 Zoom e Pan della Lavagna (<kbd>Z</kbd>)**:
  * Ingrandisce l'inquadratura (1.5x, 2.0x, 2.5x, 3.0x) per leggere formule matematiche, pedici o diagrammi scritti in piccolo.
  * Consente di trascinare liberamente l'inquadratura col mouse per seguire il docente lungo tutta la lavagna.
* **🎨 Filtri Video per Lavagne Sbiadite (<kbd>C</kbd>)**:
  * *Alto Contrasto*: Aumenta la nitidezza del gesso chiaro su lavagne scure o verdi rovinate.
  * *Bianco e Nero*: Rimuove aloni, riflessi e aberrazioni cromatiche.
  * *Modalità Notturna*: Attenua la luminosità generale per ridurre l'affaticamento durante le sessioni di studio serali.
* **🌙 Dark Mode per Slide Bianche (<kbd>I</kbd>)**:
  * Inverte dinamicamente i colori delle presentazioni PowerPoint o PDF a sfondo bianco, trasformandole in una modalità scura per riposare gli occhi.
* **🔁 Ripetizione Loop A-B (<kbd>A</kbd> / <kbd>B</kbd> / <kbd>Esc</kbd>)**:
  * Premi <kbd>A</kbd> per il punto di inizio e <kbd>B</kbd> per il punto di fine di una dimostrazione o esercizio difficile: il player ripeterà a ciclo continuo quell'intervallo finché non premi <kbd>Esc</kbd>.
* **📝 Blocco Appunti con Timestamp (<kbd>N</kbd>)**:
  * Prendi appunti direttamente a fianco del video con il minuto corrente salvato automaticamente.
  * Esportazione pulita in formato Markdown, pronta per essere incollata o importata in Notion o Obsidian.
* **⏱️ Calcolatore Orario Fine Lezione (Live ETA)**:
  * Mostra in tempo reale l'ora esatta in cui finirà la riproduzione tenendo conto della velocità attualmente impostata.
* **🔄 Ripresa Automatica della Riproduzione**:
  * Memorizza la posizione del video e ti permette di riprendere dal secondo esatto in cui avevi interrotto lo studio.
* **📸 Cattura Slide in HD con Copia negli Appunti (<kbd>S</kbd>)**:
  * Scatta un'istantanea della slide ad alta risoluzione e la copia direttamente negli appunti di sistema, pronta per essere incollata con `Ctrl + V` nei tuoi documenti.

---

## ⌨️ Tabella Scorciatoie da Tastiera

| Tasto | Azione |
|---|---|
| <kbd>Spazio</kbd> / <kbd>K</kbd> | Play / Pausa |
| <kbd>→</kbd> / <kbd>←</kbd> | Salta avanti / indietro 10 secondi |
| <kbd>Shift</kbd> + <kbd>→</kbd> / <kbd>←</kbd> | Salta avanti / indietro 30 secondi |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Velocità +0.10x / −0.10x |
| <kbd>]</kbd> / <kbd>[</kbd> | Velocità +0.25x / −0.25x |
| <kbd>R</kbd> | Ripristina velocità a 1.0x / Alterna velocità precedente |
| <kbd>Z</kbd> | Attiva / aumenta Zoom lavagna (fino a 3.0x con trascinamento) |
| <kbd>C</kbd> | Cicla tra i filtri video (contrasto, bianco e nero, notturno) |
| <kbd>I</kbd> | Inverte i colori (Dark Mode per diapositive a sfondo chiaro) |
| <kbd>A</kbd> / <kbd>B</kbd> | Imposta marcatore A (inizio) e marcatore B (fine) per Loop |
| <kbd>Esc</kbd> | Disattiva Zoom lavagna o cancella il Loop A-B |
| <kbd>X</kbd> | Attiva / disattiva il salto automatico dei silenzi |
| <kbd>N</kbd> | Aggiungi nuova nota con timestamp al minuto corrente |
| <kbd>S</kbd> | Salva screenshot della slide negli appunti (incolla con Ctrl+V) |
| <kbd>P</kbd> | Picture-in-Picture (finestra video fluttuante) |
| <kbd>F</kbd> | Schermo intero (Fullscreen) |
| <kbd>M</kbd> | Muto / Riattiva audio |
| <kbd>H</kbd> | Mostra / Nascondi barra di studio |
| <kbd>0</kbd>–<kbd>9</kbd> | Salta istantaneamente al 0%, 10%, 20%... 90% della durata |

---

## 💻 Installazione in Chrome

1. Scarica o clona questa repository sul tuo computer.
2. Apri Google Chrome e inserisci nella barra degli indirizzi: `chrome://extensions/`
3. Attiva l'opzione **"Modalità sviluppatore"** in alto a destra.
4. Clicca sul pulsante **"Carica estensione non pacchettizzata"** in alto a sinistra.
5. Seleziona la cartella contenente l'estensione.
6. L'estensione **PoliMi Webex Enhancer** è ora attiva e pronta all'uso su ogni registrazione Webex del Politecnico di Milano!

---

## 📜 Crediti & Licenza

Distribuito con licenza [GPL-3.0](LICENSE).  
L'idea iniziale delle prime scorciatoie per Webex è ispirata dai lavori della community studentesca del Politecnico di Milano (*CiscoWebexHelper* di PoliNetwork). Il progetto è stato successivamente riprogettato e riscritto da zero per introdurre l'architettura Manifest V3, il Player Offline dedicato, la trascrizione con intelligenza artificiale Whisper e l'intera suite di strumenti avanzati per lo studio.
