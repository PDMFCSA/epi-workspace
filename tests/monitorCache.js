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
const buildQueryParams = require("../gtin-resolver/lib/utils/buildQueryParams.js").buildQueryParams;

const crypto = require("opendsu").loadAPI("crypto");
const SmartUrl = require("opendsu").loadApi("utils").SmartUrl;

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

const getDBConfig = () => {
    return {
        uri: config.db.uri,
        username: process.env.DB_USER || config.db.user,
        secret: process.env.DB_SECRET || config.db.secret,
        debug: config.db.debug,
        readOnlyMode: process.env.READ_ONLY_MODE || false
    }
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

const generateURL = (domain, leaflet_type, gtin, language, batchNumber) => {
  const queryParams = buildQueryParams(gtin, batchNumber, language, leaflet_type, undefined);
  return `/leaflets/${domain}?${queryParams}`;
}

const REASONS = {
    DELETE_LEAFLET: "Deleted Leaflet",
    CREATE_PRODUCT: "Created Product"
} 

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
    return function deactivateRelatedFixedUrl(domain, query, callback){
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
    
            call(targets, `url like (${query})`, callback);
        });
    }
}

const getActivateRelatedFixedURLHandler = function (getReplicasFnc){
    return function activateRelatedFixedUrl(domain, query, callback){
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

                call(targets, `url like (${query})`, callback);
            });
        }

        next();
    }
}

const monitorCache = async () => {
    try {
        getConfig();
        getDBService();
        const domain = env.EPI_DOMAIN;
        const subdomain = env.EPI_SUBDOMAIN;

        const dbAuditName = ["db", "db", domain.replaceAll(".", "-"), subdomain.replaceAll(".", "-"), "audit"].join("_");
        const dbFixedName = "db_fixedurls-db_history"

        const dbConfig = getDBConfig();

        const dbCon =  nano(
            {
                url: dbConfig.uri,
                requestDefaults: {auth: {username: dbConfig.username, password: dbConfig.secret}}
            }
        );

        const db = dbCon.use(dbAuditName);

        db.changesReader.start({since: 'now', include_docs: true}).on('change', async (change) => {
            console.log("------------------------------------------------------------------------");
            console.log("Change detected", change);

            const record = await dbService.readDocument(dbAuditName, change.id);

            console.log("Processing record", JSON.stringify(record, null, 2));

            const isBatch = record.batchNumber !== undefined && record.batchNumber !== null && record.batchNumber !== ""

            if(record.reason === REASONS.DELETE_LEAFLET && isBatch) {
                console.log(`Removing Batch leaflet cache for product: ${record.itemCode} batch: ${record.batchNumber}`);
                for(leaf of record.details) {
                    console.log(JSON.stringify(leaf, null, 2));
                    const url = generateURL(domain, leaf.epiType, record.itemCode, leaf.epiLanguage, record.batchNumber);
                    const encoded = crypto.base64URLEncode(url);
                    console.log("URL to be deleted from cache: ", url);
                    console.log("Converting URL to base64URL:", encoded)

                    const read = await dbService.readDocument(dbFixedName, encoded);
                    console.log("Verifying cache is in the system:", read)
                    await dbService.deleteDocument(dbFixedName, read.pk)
                    console.log("Deleted cache for key:", read.pk)
                }
            }

            if(record.reason === REASONS.CREATE_PRODUCT){
                console.log(`"Creating cache for product: ${record.itemCode}`)
                const query = `^/metadata/leaflet/.*\?gtin=${record.itemCode}$`
                await $$.promisify(getDeactivateRelatedFixedURLHandler(getReplicasAsSmartUrls))(domain, query);
                await $$.promisify(getActivateRelatedFixedURLHandler(getReplicasAsSmartUrls))(domain, query);
            }
           
            console.log("Finished processing");
            console.log("------------------------------------------------------------------------");
        }).on("error", (err) => {
            console.error("Failed to start changes reader", err);
        })
        
    } catch (e) {
        console.error("Failed to refresh data", e);
        throw e;
    }
}


monitorCache().then(async (res) => {
    console.log("Starting database hook")
}).catch((err) => {
    console.error("Error during script:", err)
})