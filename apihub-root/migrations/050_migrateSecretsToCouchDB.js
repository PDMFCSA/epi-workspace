const EnclaveFacade = require("loki-enclave-facade");
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const apihubModule = require("apihub");
const { Entry } = require("selenium-webdriver/lib/logging");
const config = apihubModule.getServerConfig();
const apihubRootFolder = config.storage;

const DB_NAME= "db_secrets";

const STORAGE_LOCATION = path.join(apihubRootFolder, "/external-volume/lightDB");
const COUCH_DB_MIGRATED_FILE = STORAGE_LOCATION + "/secretscouchdb.migrated";

const SECRETS_PATH = path.join(__dirname, "..", "external-volume", "secrets");

const authenticationModes = ["ocb", "ccm", "gcm"];
const keySizes = [128, 192, 256];

const DBService = EnclaveFacade.DBService;

let dbService;

function getKeyLength(algorithm) {
    for (const len of keySizes) {
        if (algorithm.includes(len.toString())) {
            return len / 8;
        }
    }

    throw new Error("Invalid encryption algorithm.");
}

const algorithm ="aes-256-gcm" 
let keylen = getKeyLength(algorithm);

function encryptionIsAuthenticated(algorithm) {
    for (const mode of authenticationModes) {
        if (algorithm.includes(mode)) {
            return true;
        }
    }

    return false;
}

function decrypt (encryptedData, decryptionKey, authTagLength = 0, options) {
    if (typeof encryptedData === "string") {
        encryptedData = Buffer.from(encryptedData);
    }
    if (typeof decryptionKey === "string") {
        decryptionKey = Buffer.from(decryptionKey);
    }

    let iv;

    if (!iv) {
        let res = getDecryptionParameters(encryptedData, authTagLength);
        iv = res.iv;
    }
    const decipher = crypto.createDecipheriv(algorithm, decryptionKey, iv, options);
    if (encryptionIsAuthenticated(algorithm)) {
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);
    }

    return Buffer.concat([decipher.update(data), decipher.final()]);
};

function getDecryptionParameters (encryptedData, authTagLength = 0) {
    let aadLen = 0;
    if (encryptionIsAuthenticated) {
        authTagLength = 16;
        aadLen = keylen;
    }

    const tagOffset = encryptedData.length - authTagLength;
    tag = encryptedData.slice(tagOffset, encryptedData.length);

    const aadOffset = tagOffset - aadLen;
    aad = encryptedData.slice(aadOffset, tagOffset);

    iv = encryptedData.slice(aadOffset - 16, aadOffset);
    data = encryptedData.slice(0, aadOffset - 16);

    return {iv, aad, tag, data};
};

async function getEncryptionKey() {
    let key;
    try {
        console.log("Loading Encryption key from environment file.");
        const json = fs.readFileSync(path.join(__dirname, '..', '..',  'env.json'), 'utf8');
        const envConfig = JSON.parse(json);
        key = envConfig.SSO_SECRETS_ENCRYPTION_KEY;
        
        if (!key) {
            console.error("No encryption key found in env.json");
            process.exit(1);
        }
    } catch (error) {
        console.error("Failed to get the encryption key in env.json", error);
        process.exit(1);
    }
    return key;
}

const createCollection = async (name) => {
    const indexes = ["pk", "timestamp"];

    try {
        let dbName = name;

        dbName = dbService.changeDBNameToLowerCaseAndValidate(dbName);
    
        const exists = await dbService.dbExists(dbName);
    
        if (exists)
            return

        await dbService.createDatabase(dbName, indexes);
    } catch (e) {
        throw e
    }
}

async function insertSecretIntoCouchDB(fileName, value) {
    await insertRecord(DB_NAME, fileName, value);
}

const insertRecord = async (dbName, pk, value) => {
    try { 
        const exists = await dbService.dbExists(dbName);
    
        if (!exists)
            throw new Error(`Database Doesn't exist: ${dbName}! Failed to migrate!`);

        await dbService.insertDocument(dbName, pk, {value: ArrayBuffertoBase64(value)})
    } catch (e) {
        console.log("Record Already exists!");
        // throw e
    }
}

function ArrayBuffertoBase64(buffer){
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }

    const value = btoa(binary);   
    return value
}

async function migrateSecretFile(file, encryptionKey){
    const fileName = file.name;

    try {
        const secretPath = path.join(SECRETS_PATH, fileName);
        const secretContent = fs.readFileSync(secretPath);
        const decryptedContent = decrypt(secretContent, encryptionKey);

        await insertSecretIntoCouchDB(DB_NAME, fileName, secretContent);
    } catch (error) {
        console.log(`Error migrating ${fileName}:`, error);
    }
}

async function migrateSecretsToCouchDB() {
    try {
        fs.mkdirSync(path.dirname(STORAGE_LOCATION), {recursive: true});
    } catch (e) {
        // if folder exists do nothing else throw error
        if (e.code !== "EEXIST") {
            throw e;
        }
    }

    try {
        fs.accessSync(COUCH_DB_MIGRATED_FILE);
        console.log("Already migrated to Couch DB");
        return;
    } catch (e) {
        // continue with migration
    }

    const userName = process.env.DB_USER || config.db.user;
    const secret = process.env.DB_SECRET || config.db.secret;

    dbService = new DBService( {
        uri: config.db.uri,
        username: userName,
        secret: secret,
        debug: config.db.debug || false
    });

    let files;

    try {
        files = fs.readdirSync(SECRETS_PATH, {withFileTypes: true});
    } catch (e) {
        console.error("No secrets folder found! Nothing to migrate! Exiting...");
        return;
    }


    const key = await getEncryptionKey();
    const encryptionKey = Buffer.from(key, "base64");

    await createCollection(DB_NAME);

    for(const file of files) {
        await migrateSecretFile(file, encryptionKey);
    }


    // MARK AS COMPLETED
    fs.writeFileSync(COUCH_DB_MIGRATED_FILE, 'Completed couchDB Secrets migration!');

}

module.exports = migrateSecretsToCouchDB;