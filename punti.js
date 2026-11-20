/* La Spesa Sfusa per te – calcolo dei punti.
   Un solo file, uguale per l'app dei clienti e (dal passo 3) per il Magazzino.
   Regole approvate da Matteo il 17 e il 19/11/2026 (riepilogo «Le regole dei punti»).
   Gli importi sono in centesimi, così i conti non hanno errori di virgola. */
(function (radice, fabbrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabbrica();
  else radice.Punti = fabbrica();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const REGOLE = Object.freeze({
    sogliaBuono: 200,          // punti nel mese per un buono
    valoreBuonoCent: 500,      // 5 €
    spesaMinimaBuonoCent: 4000, // il buono si usa su una spesa di almeno 40 €
    puntiTolti: 5,             // nella spesa con il buono si tolgono 5 punti
    iscrizione: 20,
    amicaChiInvita: 30,
    amicaInvitata: 20,
    giornoAvviso: 25,
    missioni: Object.freeze([
      { id: 'settimana', titolo: 'Il prodotto della settimana', testo: 'Prendi il prodotto della settimana in 4 settimane del mese', punti: 20, serve: 4 },
      { id: 'pane', titolo: 'Il pane della settimana', testo: 'Prendi il pane in 3 giorni della stessa settimana', punti: 20, serve: 3 },
      { id: 'dolce', titolo: 'Assaggia la novità', testo: 'Prendi il dolce del mese', punti: 10, serve: 1 }
    ])
  });

  /* ---------- date: sempre stringhe AAAA-MM-GG, senza ore ---------- */
  const giorno = d => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));
  const aUTC = s => { const [a, m, g] = giorno(s).split('-').map(Number); return Date.UTC(a, m - 1, g); };
  const giorniTra = (da, a) => Math.round((aUTC(a) - aUTC(da)) / 86400000);
  const mese = s => giorno(s).slice(0, 7);
  /* settimana da lunedì a domenica: la chiave è il lunedì */
  const lunedi = s => {
    const t = aUTC(s); const gs = new Date(t).getUTCDay(); // 0 = domenica
    return new Date(t - ((gs + 6) % 7) * 86400000).toISOString().slice(0, 10);
  };
  const fineMese = s => { const [a, m] = mese(s).split('-').map(Number); return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10); };
  const fineMeseDopo = s => { const [a, m] = mese(s).split('-').map(Number); return new Date(Date.UTC(a, m + 1, 0)).toISOString().slice(0, 10); };

  /* ---------- una riga: quanti punti per euro ----------
     riga = { nome, importoCent, bottega?, scadenza? (AAAA-MM-GG della confezione venduta) }
     Ogni prodotto conta una volta sola: se valgono due regole, vale la più alta (dedotto). */
  function puntiPerEuro(riga, dataSpesa) {
    let p = 1;
    if (riga.bottega) p = 2;
    if (riga.scadenza) {
      const mancano = giorniTra(dataSpesa, riga.scadenza);
      if (mancano >= 0 && mancano <= 10) p = Math.max(p, 4);
      else if (mancano >= 11 && mancano <= 30) p = Math.max(p, 3);
    }
    return p;
  }

  /* ---------- una spesa: per ogni riga prezzo × punti per euro, somma, un solo arrotondamento per difetto ---------- */
  function puntiSpesa(spesa) {
    let centPunti = 0; // punti × 100
    const righe = spesa.righe.map(r => {
      const ppe = puntiPerEuro(r, spesa.data);
      centPunti += r.importoCent * ppe;
      return { ...r, puntiPerEuro: ppe, valoreCent: r.importoCent * ppe };
    });
    const lordi = Math.floor(centPunti / 100);
    const tolti = spesa.buonoUsato ? REGOLE.puntiTolti : 0;
    return { righe, totaleCent: spesa.righe.reduce((s, r) => s + r.importoCent, 0), lordi, tolti, punti: Math.max(0, lordi - tolti) };
  }

  /* ---------- missioni del mese ----------
     spese del mese con le righe; settimanali = { 'AAAA-MM-GG (lunedì)': nome del prodotto della settimana } */
  function statoMissioni(speseDelMese, settimanali) {
    const settimaneProdotto = new Set();
    const giorniPanePerSettimana = new Map();
    let dolce = false;
    for (const s of speseDelMese) {
      const lun = lunedi(s.data);
      for (const r of s.righe) {
        if (r.prodottoSettimana || (settimanali && settimanali[lun] && settimanali[lun] === r.nome)) settimaneProdotto.add(lun);
        if (r.pane) {
          if (!giorniPanePerSettimana.has(lun)) giorniPanePerSettimana.set(lun, new Set());
          giorniPanePerSettimana.get(lun).add(giorno(s.data));
        }
        if (r.dolceDelMese) dolce = true;
      }
    }
    const panePiuAlto = Math.max(0, ...[...giorniPanePerSettimana.values()].map(x => x.size));
    const fatto = { settimana: settimaneProdotto.size, pane: panePiuAlto, dolce: dolce ? 1 : 0 };
    return REGOLE.missioni.map(m => {
      const n = Math.min(fatto[m.id], m.serve);
      return { ...m, fatto: n, completa: n >= m.serve };
    });
  }

  /* quando una missione si completa, la data è quella della spesa che la chiude: serve per lo storico */
  function dataCompletamento(speseDelMese, settimanali, idMissione) {
    const ordinate = [...speseDelMese].sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
    for (let i = 0; i < ordinate.length; i++) {
      const st = statoMissioni(ordinate.slice(0, i + 1), settimanali).find(m => m.id === idMissione);
      if (st.completa) return ordinate[i].data;
    }
    return null;
  }

  /* ---------- il mese di un cliente ----------
     cliente = { iscrittoIl, spese: [{ id, data, righe, buonoUsato? }], amiche: [{ data, ruolo: 'invita'|'invitata' }] }
     oggi = AAAA-MM-GG. Il 1° del mese i punti e le missioni ripartono da zero. */
  function mese_(cliente, oggi, settimanali) {
    const m = mese(oggi);
    const movimenti = [];
    if (cliente.iscrittoIl && mese(cliente.iscrittoIl) === m) movimenti.push({ data: giorno(cliente.iscrittoIl), tipo: 'iscrizione', titolo: 'Iscrizione', punti: REGOLE.iscrizione });
    for (const a of cliente.amiche || []) {
      if (mese(a.data) !== m) continue;
      movimenti.push(a.ruolo === 'invita'
        ? { data: giorno(a.data), tipo: 'amica', titolo: 'Hai portato un’amica', punti: REGOLE.amicaChiInvita }
        : { data: giorno(a.data), tipo: 'amica', titolo: 'Benvenuta: codice di un’amica', punti: REGOLE.amicaInvitata });
    }
    const speseMese = (cliente.spese || []).filter(s => mese(s.data) === m && giorno(s.data) <= oggi);
    for (const s of speseMese) {
      const c = puntiSpesa(s);
      movimenti.push({ data: giorno(s.data), tipo: 'spesa', titolo: s.buonoUsato ? 'Spesa con il buono' : 'Spesa', punti: c.punti, totaleCent: c.totaleCent, dettaglio: c });
    }
    const missioni = statoMissioni(speseMese, settimanali);
    for (const mi of missioni) {
      if (!mi.completa) continue;
      const d = dataCompletamento(speseMese, settimanali, mi.id);
      movimenti.push({ data: d, tipo: 'missione', titolo: 'Missione: ' + mi.titolo, punti: mi.punti });
    }
    movimenti.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
    const totale = movimenti.reduce((s, x) => s + x.punti, 0);
    const buoni = Math.floor(totale / REGOLE.sogliaBuono);
    const nelBarattolo = totale - buoni * REGOLE.sogliaBuono;
    const mancano = REGOLE.sogliaBuono - nelBarattolo;
    const giornoDelMese = Number(oggi.slice(8, 10));
    return {
      mese: m, oggi, movimenti, missioni, totale, buoniGuadagnati: buoni, nelBarattolo, mancano,
      fineMese: fineMese(oggi),
      avviso: giornoDelMese >= REGOLE.giornoAvviso ? { mancano, fineMese: fineMese(oggi) } : null
    };
  }

  /* ---------- buoni di un cliente: quelli guadagnati nei mesi, valgono fino alla fine del mese dopo ---------- */
  function buoni(cliente, oggi, settimanaliPerMese) {
    const mesi = new Set();
    if (cliente.iscrittoIl) mesi.add(mese(cliente.iscrittoIl));
    for (const s of cliente.spese || []) mesi.add(mese(s.data));
    for (const a of cliente.amiche || []) mesi.add(mese(a.data));
    const elenco = [];
    for (const m of [...mesi].sort()) {
      if (m > mese(oggi)) continue;
      const ultimo = m === mese(oggi) ? oggi : fineMese(m + '-01');
      const r = mese_(cliente, ultimo, settimanaliPerMese);
      // il buono nasce il giorno della spesa che fa superare 200, 400…
      let somma = 0, n = 0;
      for (const mv of r.movimenti) {
        somma += mv.punti;
        while (somma >= (n + 1) * REGOLE.sogliaBuono) { n++; elenco.push({ id: m + '-' + n, guadagnatoIl: mv.data, scade: fineMeseDopo(m + '-01') }); }
      }
    }
    const usati = (cliente.spese || []).filter(s => s.buonoUsato && giorno(s.data) <= oggi).map(s => ({ data: giorno(s.data), id: s.buonoUsato }));
    return elenco.map(b => {
      const uso = usati.find(u => u.id === b.id);
      const stato = uso ? 'usato' : (oggi > b.scade ? 'scaduto' : 'da usare');
      return { ...b, stato, usatoIl: uso ? uso.data : null };
    });
  }

  /* il buono si può usare solo su una spesa di almeno 40 €, uno per spesa (si controlla in cassa) */
  const buonoUsabile = totaleCent => totaleCent >= REGOLE.spesaMinimaBuonoCent;

  return { REGOLE, puntiPerEuro, puntiSpesa, statoMissioni, mese: mese_, buoni, buonoUsabile, util: { giorniTra, lunedi, fineMese, fineMeseDopo, mese } };
});
