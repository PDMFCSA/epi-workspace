const fs = require('fs');
const path = require('path');
const libxmljs = require('libxmljs2');

const argPath = process.argv?.[2] || undefined;

if(!argPath) {
    console.error('[ERROR] -No path provided');
    process.exit(1);
}

const leafletPath = path.resolve(__dirname, '../', argPath);

if (!fs.existsSync(leafletPath)) {
  console.error(`[ERROR] - Leaflet file not found: ${leafletPath}`);
  process.exit(1);
}

const schemaContent = fs.readFileSync(path.resolve(__dirname, '../', 'tests/resources/leaflet-schema.xsd'), 'utf8');

function validateXmlContent() {
    const xmlContent = fs.readFileSync(path.resolve(__dirname, leafletPath), 'utf8');
    const xmlDoc = libxmljs.parseXml(xmlContent);
    const xsdDoc = libxmljs.parseXml(schemaContent);
    const result = xmlDoc.validate(xsdDoc);
    if(!result) {
        console.error('[ERROR] - Invalid leaflet schema', xmlDoc.validationErrors);
        process.exit(1);
    }
    console.log('[SUCCESS] - Valid leaflet schema');
    process.exit(0);
}

validateXmlContent();