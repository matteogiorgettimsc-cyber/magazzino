# Magazzino – La Spesa Sfusa

App per il negozio: vendita al banco, scadenze e ordini, funziona anche senza internet.

- I dati restano sul telefono (non su questo sito).
- Il catalogo con i prezzi si carica dal file `catalogo_iniziale.json`, che **non** è in questo archivio.
- Banco: il cassiere batte in cassa come sempre e scansiona il prodotto nell'app; il pezzo esce dalla confezione che scade prima. A fine giornata, "Chiusura di oggi" confronta l'incasso della cassa con quanto scansionato.
- Sfuso (dalla 1.4.0): nella scheda prodotto si spunta "Sfuso", si sceglie come si vende (al kg, all'etto o al litro) e si scrive il peso del sacco o i litri della tanica; magazzino in kg (litri per i liquidi), arrivi a sacchi o taniche, al banco si scansiona l'etichetta del contenitore e si scrivono grammi o ml. Quando al sacco più vecchio resta meno del 5% l'app passa al successivo.
- Etichette (A4, 70 × 37 mm, 24 per foglio): se il prodotto sfuso non ha codice, al salvataggio l'app lo crea e apre subito la stampa della sua etichetta (dalla 1.5.0). Tutte le etichette da Catalogo → "Etichette dei contenitori sfusi". L'app ricorda la prima etichetta libera del foglio, così un foglio iniziato si riusa.
- Backup: dall'app, pulsante "Fai backup", poi salva il file su Drive. Dalla versione 1.3.0 il backup contiene anche le vendite.

