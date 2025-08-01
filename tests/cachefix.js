const fs = require('fs');
const path = require('path');
const process = require("process");
const nano = require('nano');


let env = {};

const constants = {
    PRODUCT_DSU_MOUNT_POINT: "/product",
    BATCH_DSU_MOUNT_POINT: "/batch",
}

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

const SmartUrl = require("opendsu").loadApi("utils").SmartUrl;

const openDSU = require("opendsu");
const keyssiSpace = openDSU.loadApi("keyssi");
const resolver = openDSU.loadAPI("resolver");

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

const refreshCache = async () => {
    try {
        getConfig();
        getDBService();
        const domain = env.EPI_DOMAIN;
        const subdomain = env.EPI_SUBDOMAIN;

        console.log(`Restoring Fixed URL cache for domain ${domain} and subdomain ${subdomain}`);
        await removeFixedURLsCache("Fixed-URLS-history", domain, subdomain);
        console.log("RemovedFixed URL records");
        console.log(`Restoring Fixed Urls cache for domain ${domain} and subdomain ${subdomain}`);
        await recreateFixedUrlsCache("products", domain, subdomain);
        console.log("Restored Fixed Urls fixed URL cache for products");
        await recreateFixedUrlsCache("batches", domain, subdomain);
        console.log("Restored Fixed Urls fixed URL cache for batches");
        console.log("Triggering full refresh for domain", domain, "and subdomain", subdomain);
        await refreshFixedURLs(domain);
        console.log("Refresh completed!")
    } catch (e) {
        console.error("Failed to refresh data", e);
        throw e;
    }
}

const getAllRecords = async (dbName, tableName, limit = 250) => {
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

const createGTIN_SSI = function(domain, bricksDomain, gtin, batch) {
    console.log(`New GTIN_SSI in domain:${domain} and bricksDomain:${bricksDomain}`);
    let hint = {avoidRandom : true};
    if (typeof bricksDomain !== "undefined") {
        hint[openDSU.constants.BRICKS_DOMAIN_KEY] = bricksDomain;
    }
    hint = JSON.stringify(hint);
    let realSSI = keyssiSpace.createArraySSI(domain, [gtin, batch], 'v0', hint);

    return realSSI;
}

const recreateFixedUrlsCache = async (tableName, domain, subdomain) => {
    console.log("====================================================================================================");
    console.log(`Trying to recreate metadata for records from table ${tableName}`);
    console.log("====================================================================================================");

    let records;

    let dbName = ["db", "db", domain.replaceAll(".", "-"), subdomain.replaceAll(".", "-"), tableName].join("_");
    
    try {
        records = await getAllRecords(dbName, dbName);
    } catch (error) {
        console.log("Failed to get records from table", dbName, error);
        records = [];
    }

    let fixedUrlUtils = require("../gtin-resolver/lib/mappings/utils.js");
    const resolve = $$.promisify(resolver.resolve);

    for(let i = 0; i < records.length; i++) {
        console.log("====================================================================================================");
        console.log(`Processing record ${i} of ${records.length}`);
        console.log("Product Code: ", records[i].productCode);
        if(tableName === "batches") console.log("Batch Number: ", records[i].batchNumber);
        console.log("Domain: ", domain , " / ", subdomain);

        try {
            console.log(`Restoring metadata fixed url for \n Domain: ${domain}\n SubDomain: ${subdomain} \n Product code:${records[i].productCode}\n ${records[i].batchNumber ? "Batch number: " + records[i].batchNumber : ""}`);
            await fixedUrlUtils.registerLeafletMetadataFixedUrlByDomainAsync(domain, subdomain, records[i].productCode, records[i].batchNumber || undefined);  
            if(tableName === "products") {
                console.log(`Restoring Gtin Owner fixed url for \n Domain: ${domain}\n SubDomain: ${subdomain} \n Product code:${records[i].productCode}`);
                 await fixedUrlUtils.registerGtinOwnerFixedUrlByDomainAsync(domain, records[i].productCode);
            }


            
            
            // para cada leaflet
            let leaflet_type= ""
            let market = ""
            let lang = ""

            await fixedUrlUtils.registerLeafletFixedUrlByDomain(domain, subdomain, leaflet_type, records[i].productCode,lang, records[i].batchNumber || undefined, undefined, undefined);

        } catch (e) {
            console.error("Failed to restore metadata fixed url: ", JSON.stringify(records[i], null, 2), "/n",  e);
        }
        console.log("====================================================================================================");
    }

    console.log(`Restored ${records.length} fixed URLS for table ${tableName}`)


}

const removeFixedURLsCache = async (tableName, domain, subdomain) => {
    console.log("====================================================================================================");
    console.log(`Trying to recreate fixed url cache for records from table ${tableName}`);
    console.log("====================================================================================================");

    let dbName = "db_fixedurls-db_history"

    try {
        records = await getAllRecords(dbName, dbName);
    } catch (error) {
        console.log("Failed to get records from table", dbName, error);
        records = [];
    }

    records.forEach((record) => {
        console.log(`Processing record ${record.pk}`);
        
        try {
            dbService.deleteDocument(dbName, record.pk)
        } catch (e) {
            console.error("Failed to refresh fixed url: ", JSON.stringify(record, null, 2), "/n",  e);
        }
    })
}

const refreshFixedURLs = async (domain) => {
    const call = function(endpoints, body, callback){
        function executeRequest(){
            if(endpoints.length === 0){
                const msg = `Not able to activate fixedUrl`;
                console.log(msg);
                return callback(new Error(msg));
            }

            let apihubEndpoint = endpoints.shift();
            apihubEndpoint.doPut(body, {}, (err) => {
            if (err) {
                console.error(err);
                //if we get error we try to make a call to other endpoint if any
                executeRequest();
            } else {
                return callback(undefined, true);
            }
            });
        }

        executeRequest();
    }

    const getReplicasAsSmartUrls = function(targetDomain, callback){
        const BDNS = require("opendsu").loadApi("bdns");
        BDNS.getAnchoringServices(targetDomain, (err, endpoints)=> {
            if (err) {
                return callback(err);
            }
            let replicas = [];
            for(let endpoint of endpoints){
                replicas.push(new SmartUrl(endpoint));
            }
            return callback(undefined, replicas);
        });
    }

    const getDeactivateRelatedFixedURLHandler = function(getReplicasFnc){
        return function deactivateRelatedFixedUrl(domain, callback){
            getReplicasFnc(domain, function(err, replicas){
            if(replicas.length === 0){
                const msg = `Not able to deactivate fixedUrls`;
                console.log(msg);
                return callback(new Error(msg));
            }
            let targets = [];
            for(let replica of replicas){
                targets.push(replica.concatWith("/deactivateFixedURL"));
            }
            const query = ".*"
            call(targets, `url like (${query})`, callback);
            });
        }
    }

    function getActivateRelatedFixedURLHandler(getReplicasFnc){
    return function activateRelatedFixedUrl(domain, callback){
        if(typeof callback === "undefined"){
            callback = (err)=>{
                if(err){
                    console.error(err);
                }
            }
        }

        let next = async ()=>{
            //we were able to commit the new changes then we should call the fixedUrl endpoints
            getReplicasFnc(domain, function(err, replicas){
                if(replicas.length === 0){
                    const msg = `Not able to activate fixedUrls`;
                    console.log(msg);
                    return callback(new Error(msg));
                }
                let targets = [];
                for(let replica of replicas){
                    targets.push(replica.concatWith("/activateFixedURL"));
                }

                const query = ".*"
                call(targets, `url like (${query})`, callback);
            });
            }

            next();
        }
    }

    const deactivate = $$.promisify(getDeactivateRelatedFixedURLHandler(getReplicasAsSmartUrls));
    const activate = $$.promisify(getActivateRelatedFixedURLHandler(getReplicasAsSmartUrls));


    await deactivate(domain);
    await activate(domain);
    console.log("finished test")
}


refreshCache().then((res) => {
    console.log("Refresh completed successfully.")
}).catch((err) => {
    console.error("Error during refresh:", err)
})