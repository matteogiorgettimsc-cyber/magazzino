# Magazzino – La Spesa Sfusa

App per il negozio: vendita al banco, scadenze e ordini, funziona anche senza internet.

- I dati restano sul telefono (non su questo sito).
- Il catalogo con i prezzi si carica dal file `catalogo_iniziale.json`, che **non** è in questo archivio.
- Banco: il cassiere batte in cassa come sempre e scansiona il prodotto nell'app; il pezzo esce dalla confezione che scade prima. A fine giornata, "Chiusura di oggi" confronta l'incasso della cassa con quanto scansionato.
- Sfuso (dalla 1.4.0): nella scheda prodotto si spunta "Venduto a peso" e si scrive il peso del sacco; magazzino in kg, arrivi a sacchi, al banco si scansiona l'etichetta del contenitore e si scrive il peso. Quando al sacco più vecchio resta meno del 5% l'app passa al successivo. Le etichette dei contenitori (A4, 70 × 37 mm) si stampano da Catalogo → "Etichette dei contenitori sfusi".
- Backup: dall'app, pulsante "Fai backup", poi salva il file su Drive. Dalla versione 1.3.0 il backup contiene anche le vendite.

