const fs = require('fs');
const path = require('path');
const process = require("process");
const nano = require('nano');

let env = {};

const setEnvVars = async () => {
    try {
        const envFile = fs.readFileSync(path.join("../env.json"), 'utf8')
        env = JSON.parse(envFile);
    } catch(e) {
        console.error("Failed to read env", e);
        env = {}
    }
}

setEnvVars();

process.env.PSK_ROOT_INSTALATION_FOLDER = path.resolve(path.join(__dirname));
require(path.join(__dirname, './builds/output/pskWebServer.js'));

let config;

const EnclaveFacade = require("loki-enclave-facade");
const DBService = EnclaveFacade.DBService;

let dbService;

const getConfig = async () => {
    if(!config){
        try{
            const configFile = fs.readFileSync(path.join("../apihub-root/external-volume/config/apihub.json"), 'utf8')
            config = JSON.parse(configFile);
        } catch(e) {
            console.error("Failed to read config", e);
            config = {}
        }
    }

    return config
}

const getDBService = async () => {
    if (!dbService) {
        dbService = new DBService( {
            uri: config.db.uri,
            username: process.env.DB_USER || config.db.user,
            secret: process.env.DB_SECRET || config.db.secret,
            debug: config.db.debug,
            readOnlyMode: process.env.READ_ONLY_MODE || false
        });
    }

    return dbService;
}

const refreshMetadata = async () => {
    try {
        getConfig();
        getDBService();
        const domain = env.EPI_DOMAIN;
        const subdomain = env.EPI_SUBDOMAIN;
        console.log(`Restoring metadata for domain ${domain} and subdomain ${subdomain}`);
        await recreateMetadataFixedUrl("products", domain, subdomain);
        console.log("Restore metadata fixed URL for products");
        await recreateMetadataFixedUrl("batches", domain, subdomain);
        console.log("Restore metadata fixed URL for batches");
    } catch (e) {
        console.error("Failed to refresh data", e);
        throw e;
    }
}


const recreateMetadataFixedUrl = async (tableName, domain, subdomain) => {
    console.log("====================================================================================================");
    console.log(`Trying to recreate metadata for records from table ${tableName}`);
    console.log("====================================================================================================");

    let records;

    const getAllRecords = async (tableName, limit = 250) => {
        let allRecords = [];
        let lastKey = null;
        let hasMore = true;

        const docCount = await dbService.countDocs(dbName);


        while (hasMore) {
            try {
                const result = await dbService.filter(tableName, ["_id > 0"], [{["_id"]: "asc"}], limit, lastKey);
                allRecords = allRecords.concat(result);
                
                if (allRecords.length < docCount) {
                    lastKey = result[result.length - 1].__key;
                } else {
                    hasMore = false;
                }
            } catch (error) {
                console.error("Error fetching records:", error);
                hasMore = false;
            }
        }

        console.log(`Fetched ${allRecords.length} records from table ${tableName}`);

        return allRecords;
    }

    let dbName = ["db", "db", domain.replaceAll(".", "-"), subdomain.replaceAll(".", "-"), tableName].join("_");
    
    try {
        records = await getAllRecords(dbName);
    } catch (error) {
        console.log("Failed to get records from table", dbName, error);
        records = [];
    }

    let fixedUrlUtils = require("../gtin-resolver/lib/mappings/utils.js");

    let count = 0;

    for (let record of records) { 
        count++;
        console.log(`Processing record ${count} of ${records.length}`);
        try {
            await fixedUrlUtils.registerLeafletMetadataFixedUrlByDomainAsync(domain, subdomain, record.productCode, record.batchNumber || undefined);  
            await fixedUrlUtils.deactivateMetadataFixedUrl(undefined, "metadata", domain, record.productCode, record.batchNumber || undefined, undefined, undefined, undefined);
            await fixedUrlUtils.activateMetadataFixedUrl(undefined, "metadata", domain, record.productCode, record.batchNumber || undefined, undefined, undefined, undefined);
        } catch (e) {
            console.error("Failed to restore metadata fixed url: ", record, "/n",  e);
        }
    }


    console.log(`Restored ${records.length} metadata fixed URLS for table ${tableName}`)
}


refreshMetadata().then((res) => {
    console.log("Refresh completed successfully.")
}).catch((err) => {
    console.error("Error during refresh:", err)
})