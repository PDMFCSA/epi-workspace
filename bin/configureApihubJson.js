const fs = require('fs');
const path = require('path');

const apihubJsonPath = "apihub-root/external-volume/config/apihub.json"
const ssoTokenPath = path.join(process.cwd(), ".ssotoken");

const localValues = {
    server_authentication: true,
    dns_name: "localhost:8080",
    logout_url: "https://login.microsoftonline.com/cbfd70ab-7873-4375-bf63-334828046900/oauth2/logout",
    client_secret: fs.readFileSync(ssoTokenPath, 'utf8'),
    client_id: "e65a2002-324f-48f2-b32f-a40b76d5f821",
    token_endpoint: "https://login.microsoftonline.com/cbfd70ab-7873-4375-bf63-334828046900/oauth2/v2.0/token",
    authorization_endpoint: "https://login.microsoftonline.com/cbfd70ab-7873-4375-bf63-334828046900/oauth2/v2.0/authorize",
    issuer: "https://login.microsoftonline.com/cbfd70ab-7873-4375-bf63-334828046900/oauth2/v2.0/",
    whitelist: "https://login.microsoftonline.com",
    oauth_jwks_endpoint: "https://login.microsoftonline.com/cbfd70ab-7873-4375-bf63-334828046900/discovery/v2.0/keys",
    enable_oauth: true
}


function replacePlaceholders(input, values) {
    return input.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (match, variable) => {
        if (values.hasOwnProperty(variable)) {
            return values[variable];
        }
        // If the variable is not in the mapping, return the original placeholder
        return match;
    });
}

function configureApiHubJson(){

    try {
        const jsonString = fs.readFileSync(apihubJsonPath, 'utf8');

        const updatedJsonString = replacePlaceholders(jsonString, localValues)
        
        const jsonData = JSON.parse(updatedJsonString)

        fs.writeFileSync(apihubJsonPath, JSON.stringify(jsonData, null, 2), 'utf8');
        console.log(`Successfully updated apihub.json`);
    } catch (error) {
        console.error(`Error updating JSON file: ${error.message}`);
    }
}

configureApiHubJson()