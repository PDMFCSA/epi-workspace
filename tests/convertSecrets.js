const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const authenticationModes = ["ocb", "ccm", "gcm"];
const keySizes = [128, 192, 256];

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

async function testSecretFromCommandLine() {
    let key = process.argv[2];

    if (!key) {
        try {
            console.log("Since no key was provided we will try to use the key in env.json file.");
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
    }
    
    try {
        let encryptionKey = Buffer.from(key, "base64");

        const secretsPath = path.join(__dirname, "secrets");

        const secretFolderContent = fs.readdirSync(secretsPath, {withFileTypes: true});

        for (let entry of secretFolderContent) {
            try {
                let name = entry.name;
                const secretPath = path.join(secretsPath, name);
                const secretContent = fs.readFileSync(secretPath);
                const b = decrypt(secretContent, encryptionKey);
                fs.writeFileSync("./secrets/" + name.split(".")[0] + ".json", b, {flag:"w"});
                
                console.log(`${name} decrypted successfully!`);
            } catch (error) {
                console.log(`Failed to decrypt ${name}!`);
            }
        }
        
    } catch (error) {
        return console.log(`Error decrypting secret: ${error.message}`);
    }
    console.log("adminApiKeys.secret decrypted successfully!");
}

testSecretFromCommandLine().then(_ => console.log("All secrets decrypted successfully!")).catch(e => console.error(e));