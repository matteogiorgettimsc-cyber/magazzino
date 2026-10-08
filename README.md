# Magazzino – La Spesa Sfusa

App per il negozio: vendita al banco, scadenze e ordini, funziona anche senza internet.

- I dati restano sul telefono (non su questo sito); con più dispositivi collegati passano anche dal database Firebase del negozio.
- Il catalogo con i prezzi si carica dal file `catalogo_iniziale.json`, che **non** è in questo archivio.
- Banco: il cassiere batte in cassa come sempre e scansiona il prodotto nell'app; il pezzo esce dalla confezione che scade prima. A fine giornata, "Chiusura di oggi" confronta l'incasso della cassa con quanto scansionato.
- Sfuso (dalla 1.4.0): nella scheda prodotto si spunta "Sfuso", si sceglie come si vende (al kg, all'etto o al litro) e si scrive il peso del sacco o i litri della tanica; magazzino in kg (litri per i liquidi), arrivi a sacchi o taniche, al banco si scansiona l'etichetta del contenitore e si scrivono grammi o ml. Quando al sacco più vecchio resta meno del 5% l'app passa al successivo.
- Etichette (A4, 70 × 37 mm, 24 per foglio): se il prodotto sfuso non ha codice, al salvataggio l'app lo crea e apre subito la stampa della sua etichetta (dalla 1.5.0). Tutte le etichette da Catalogo → "Etichette dei contenitori sfusi". L'app ricorda la prima etichetta libera del foglio, così un foglio iniziato si riusa.
- Più dispositivi (dalla 1.6.0): Impostazioni → "Più dispositivi insieme" → email e password del negozio. Le modifiche passano da Firebase (Firestore, progetto magazzino-spesa-sfusa-69c90); senza internet restano in coda e partono appena torna la rete. Le quantità delle confezioni sono la somma dei contributi di ogni dispositivo, così vendite in contemporanea non si perdono.
- Prezzi (dalla 1.8.2): vale il prezzo di vendita scritto a mano; se non c'è, quello calcolato da acquisto, ricarico e IVA. Il prezzo del listino non si usa più.
- Fatture (dalla 1.9.0): Home → "Fatture e pagamenti" → "Carica fatture". Si caricano i file scaricati da Fatture e Corrispettivi (.xml, .p7m o .zip). L'app collega le righe ai prodotti (dal codice a barre, dal codice del fornitore che impara, o chiedendo una volta), confronta quanto fatturato con gli arrivi registrati, propone di aggiornare i prezzi d'acquisto (il prezzo scritto a mano resta, con un avviso se è sotto il costo) e raccoglie le scadenze dei pagamenti.
- Pagamenti (dalla 1.10.0): Fatture e pagamenti → "Pagamenti": le scadenze delle fatture più le altre spese (affitto, bollette…), anche ripetute ogni mese o ogni anno. Segnata pagata una spesa che si ripete, l'app prepara la successiva.
- Cruscotto (dalla 1.10.0): Home → "Cruscotto": cosa c'è da fare, incassi dalle chiusure, fatture e spese del periodo, margine stimato sulle vendite scansionate, valore della merce, merce ferma da 60 giorni.
- Riepilogo del mese (dalla 1.10.0): dal Cruscotto. Incassi giorno per giorno, fatture con IVA per aliquota, spese e pagamenti; "Scarica in Excel" prepara un file .xlsx con un foglio per ogni parte.
- Storico di cassa (dalla 1.10.1): dal Cruscotto o da Chiusura di oggi; gli incassi giorno per giorno, da correggere o cancellare.
- Categorie e grafici (dalla 1.11.0): Cruscotto → "Vendite per categoria e grafici": andamento degli incassi (colonne), vendite per categoria dalla più alla meno venduta, e per ogni categoria i prodotti più e meno venduti. "Proponi dal nome" scrive la categoria ai prodotti che non ce l'hanno; dal Catalogo, Seleziona → Categoria… per più prodotti insieme.
- Backup: dall'app, pulsante "Fai backup", poi salva il file su Drive. Dalla versione 1.3.0 il backup contiene anche le vendite.

