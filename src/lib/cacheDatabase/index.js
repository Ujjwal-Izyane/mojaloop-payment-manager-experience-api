/**************************************************************************
 *  (C) Copyright ModusBox Inc. 2020 - All rights reserved.               *
 *                                                                        *
 *  This file is made available under the terms of the license agreement  *
 *  specified in the corresponding source code repository.                *
 *                                                                        *
 *  ORIGINAL AUTHOR:                                                      *
 *       Yevhen Kyriukha - yevhen.kyriukha@modusbox.com                   *
 *                                                                        *
 *  CONTRIBUTORS:                                                         *
 *       James Bush - james.bush@modusbox.com                             *
 **************************************************************************/

const knex = require('knex');
const Cache = require('./cache');

const cachedFulfilledKeys = [];
const cachedPendingKeys = [];

const getName = (userInfo) =>
    userInfo &&
    (userInfo.displayName || `${userInfo.firstName} ${userInfo.lastName}`);

const getTransferStatus = (data) => {
    if (data.currentState === 'succeeded') {
        return true;
    } else if (data.currentState === 'errored') {
        return false;
    } else {
        return null;
    }
};

const getInboundTransferStatus = (data) => {
    switch (data.currentState) {
        case 'COMPLETED':
            return true;
        case 'ERROR_OCCURRED':
        case 'ABORTED':
            return false;
        default:
            return null;
    }
};

const getPartyNameFromQuoteRequest = (qr, partyType) => {
    // return display name if we have it
    if (qr.body[partyType].name) {
        return qr.body[partyType].name;
    }

    // otherwise try to build the name from the personalInfo
    const { complexName } = qr.body[partyType].personalInfo || {};

    if (complexName) {
        const n = [];
        const { firstName, middleName, lastName } = complexName;
        if (firstName) {
            n.push(firstName);
        }
        if (middleName) {
            n.push(middleName);
        }
        if (lastName) {
            n.push(lastName);
        }
        return n.join(' ');
    }
};

async function syncDB({ redisCache, db, logger }) {
    logger.log('Syncing cache to in-memory DB');

    const parseData = (rawData) => {
        let data;
        if (typeof rawData === 'string') {
            try {
                data = JSON.parse(rawData);
            } catch (err) {
                logger.push({ err }).log('Error parsing JSON cache value');
            }
        }
        else {
            data = rawData;
        }

        if (data.direction === 'INBOUND') {
            if (data.quoteResponse?.body) {
                if(typeof data.quoteResponse.body === 'string')
                    data.quoteResponse.body = JSON.parse(data.quoteResponse.body);
            }
            if (data.fulfil?.body) {
                if(typeof data.fulfil.body === 'string')
                    data.fulfil.body = JSON.parse(data.fulfil.body);
            }
        }
        return data;
    };

    const cacheKey = async (key) => {
        const rawData = await redisCache.get(key);
        const data = parseData(rawData);

        // If the key is for a transfer
        if(key.includes('transferModel'))
        {

            // this is all a hack right now as we will eventually NOT use the cache as a source
            // of truth for transfers but rather some sort of dedicated persistence service instead.
            // Therefore we can afford to do some nasty things in order to get working features...
            // for now...

            const initiatedTimestamp = data.initiatedTimestamp
                ? new Date(data.initiatedTimestamp).getTime()
                : null;
            const completedTimestamp = data.fulfil
                ? new Date(data.fulfil.body.completedTimestamp).getTime()
                : null;

            // the cache data model for inbound transfers is lacking some properties that make it easy to extract
            // certain information...therefore we have to find it elsewhere...

            if (!['INBOUND', 'OUTBOUND'].includes(data.direction))
                logger
                    .push({ data })
                    .log('Unable to process row. No direction property found');

            const row = {
                id: data.transferId,
                redis_key: key, // To be used instead of Transfer.cachedKeys
                raw: JSON.stringify(data),
                created_at: initiatedTimestamp,
                completed_at: completedTimestamp,
                ...(data.direction === 'INBOUND' && {
                    sender: getPartyNameFromQuoteRequest(data.quoteRequest, 'payer'),
                    sender_id_type:
                      data.quoteRequest?.body?.payer?.partyIdInfo?.partyIdType,
                    sender_id_sub_value:
                      data.quoteRequest?.body?.payer?.partyIdInfo?.partySubIdOrType,
                    sender_id_value:
                      data.quoteRequest?.body?.payer?.partyIdInfo?.partyIdentifier,
                    recipient: getPartyNameFromQuoteRequest(data.quoteRequest, 'payee'),
                    recipient_id_type:
                      data.quoteRequest?.body?.payee?.partyIdInfo?.partyIdType,
                    recipient_id_sub_value:
                      data.quoteRequest?.body?.payee?.partyIdInfo?.partySubIdOrType,
                    recipient_id_value:
                      data.quoteRequest?.body?.payee?.partyIdInfo?.partyIdentifier,
                    amount: data.quoteResponse?.body?.transferAmount.amount,
                    currency: data.quoteResponse?.body?.transferAmount.currency,
                    direction: -1,
                    batch_id: '',
                    details: data.quoteRequest?.body?.note,
                    dfsp: data.quoteRequest?.body?.payer?.partyIdInfo.fspId,
                    success: getInboundTransferStatus(data),
                    supported_currencies: JSON.stringify(data.supportedCurrencies),
                }),
                ...(data.direction === 'OUTBOUND' && {
                    sender: getName(data.from),
                    sender_id_type: data.from?.idType,
                    sender_id_sub_value: data.from?.idSubType,
                    sender_id_value: data.from?.idValue,
                    recipient: getName(data.to),
                    recipient_id_type: data.to?.idType,
                    recipient_id_sub_value: data.to?.idSubType,
                    recipient_id_value: data.to?.idValue,
                    amount: data.amount,
                    currency: data.currency,
                    direction: 1,
                    batch_id: '', // TODO: Implement
                    details: data.note,
                    dfsp: data.to?.fspId,
                    success: getTransferStatus(data),
                    supported_currencies: JSON.stringify(data.supportedCurrencies),
                }),
            };

            // check if there is a key in the data object named fxQuoteResponse
            // The empty object is initialised for the case in which fxQuoteResponse is empty so we don't have to deal with null errors
            let fx_quote_row = null;
            if(data.fxQuoteRequest){
                let fxQuoteRequest = data.fxQuoteRequest.body;
                if(typeof data.fxQuoteRequest.body === 'string')
                    fxQuoteRequest = JSON.parse(fxQuoteRequest);
                fx_quote_row = {
                    redis_key: key,
                    conversion_request_id: fxQuoteRequest.conversionRequestId,
                    conversion_id: fxQuoteRequest.conversionTerms.conversionId,
                    determining_transfer_id : fxQuoteRequest.conversionTerms.determiningTransferId,
                    initiating_fsp: '',
                    counter_party_fsp: '' ,
                    amount_type: '',
                    source_amount: fxQuoteRequest.conversionTerms.sourceAmount.amount,
                    source_currency: fxQuoteRequest.conversionTerms.sourceAmount.currency ,
                    target_amount: '',
                    target_currency: fxQuoteRequest.conversionTerms.targetAmount.currency,
                    expiration: '',
                    condition: '',
                    direction: data.direction,
                    raw: JSON.stringify(data),
                    created_at: initiatedTimestamp,
                    completed_at: completedTimestamp,
                    success: getTransferStatus(data)
                };
            }
            else{
                logger.log('fxQuoteRequest does not exist on', key);
            }
            if (data.fxQuoteResponse) {
                fx_quote_row.conversion_id = data.fxQuoteResponse.body.conversionTerms.conversionId ;
                fx_quote_row.initiating_fsp = data.fxQuoteResponse.body.conversionTerms.initiatingFsp ;
                fx_quote_row.counter_party_fsp = data.fxQuoteResponse.body.conversionTerms.counterPartyFsp ;
                fx_quote_row.amount_type = data.fxQuoteResponse.body.conversionTerms.amountType ;
                fx_quote_row.source_amount = data.fxQuoteResponse.body.conversionTerms.sourceAmount.amount ;
                fx_quote_row.source_currency = data.fxQuoteResponse.body.conversionTerms.sourceAmount.currency ;
                fx_quote_row.target_amount = data.fxQuoteResponse.body.conversionTerms.targetAmount.amount ;
                fx_quote_row.target_currency = data.fxQuoteResponse.body.conversionTerms.targetAmount.currency ;
                fx_quote_row.expiration = data.fxQuoteResponse.body.conversionTerms.expiration ;
                fx_quote_row.condition = data.fxQuoteResponse.body.condition ;
            } else {
                // code to handle when fxQuoteResponse key does not exist
                logger.log('fxQuoteResponse does not exist on', key);
            }

            // Check if the fxTransferRequest and fxTransferResponse are present
            let fx_transfer_row = null;
            if (data.fxTransferRequest ) {

                const fxTransferRequestData = parseData(data.fxTransferRequest.body);
                fx_transfer_row = {
                    redis_key: key,
                    commit_request_id: fxTransferRequestData.commitRequestId,
                    determining_transfer_id: fxTransferRequestData.determiningTransferId,
                    initiating_fsp: fxTransferRequestData.initiatingFsp,
                    counter_party_fsp: fxTransferRequestData.counterPartyFsp,
                    amount_type: fxTransferRequestData.amountType,
                    source_amount: fxTransferRequestData.sourceAmount.amount,
                    source_currency: fxTransferRequestData.sourceAmount.currency,
                    target_amount: fxTransferRequestData.targetAmount.amount,
                    target_currency: fxTransferRequestData.targetAmount.currency,
                    condition: fxTransferRequestData.condition,
                    expiration: fxTransferRequestData.expiration,
                    conversion_state: '',  // if not fxTransferResponse leave empty
                    fulfilment: '', // if not fxTransferResponse leave empty
                    direction: data.direction,
                    created_at: initiatedTimestamp,
                    completed_timestamp: '',

                };

            } else {
                // code to handle when fxTransferRequest key does not exist
                logger.log('fxTransferRequest does not exist on',key);
            }
            if(data.fxTransferResponse){
                fx_transfer_row.fulfilment = data.fxTransferResponse.body.fulfilment;
                fx_transfer_row.conversion_state = data.fxTransferResponse.body.conversionState;
                fx_transfer_row.completed_timestamp = data.fxTransferResponse.body.completedTimestamp;
            }
            else{
                logger.log('fxTransferResponse does not exist on ',key);
            }

            // logger.push({ data }).log('processing cache item');
            // logger.push({ ...row, raw: ''}).log('Row processed');

            const keyIndex = cachedPendingKeys.indexOf(row.redis_key);
            if (keyIndex === -1) {
                try {
                    await db('transfer').insert(row);
                } catch (err) {
                    console.log(err);
                }
                if(fx_quote_row != undefined && fx_quote_row != null) {
                    try {
                        await db('fx_quote').insert(fx_quote_row);
                    } catch (err) {
                        console.log(err);
                    }
                }
                if(fx_transfer_row != undefined && fx_transfer_row != null) {
                    try {
                        await db('fx_transfer').insert(fx_transfer_row);
                    } catch (err) {
                        console.log(err);
                    }
                }
                cachedPendingKeys.push(row.redis_key);
            } else {
                try {
                    await db('transfer').where({ redis_key: row.redis_key}).update(row);
                } catch (err) {
                    console.log(err);
                }
                if(fx_quote_row != null && fx_quote_row != undefined) {
                    try {
                        await db('fx_quote').where({redis_key: fx_quote_row.redis_key}).update(fx_quote_row);
                    } catch (err) {
                        console.log(err);
                    }
                }
                if(fx_transfer_row != undefined && fx_transfer_row != null) {
                    try {
                        await db('fx_transfer').where({redis_key:fx_transfer_row.redis_key}).update(fx_transfer_row);
                    } catch (err) {
                        console.log(err);
                    }
                }
                // cachedPendingKeys.splice(keyIndex, 1);
            }

            if (row.success !== null) {
                cachedFulfilledKeys.push(key);
            }
        }
        // When the redis key starts with fxQuote*
        else {

            // this is all a hack right now as we will eventually NOT use the cache as a source
            // of truth for transfers but rather some sort of dedicated persistence service instead.
            // Therefore we can afford to do some nasty things in order to get working features...
            // for now...


            const initiatedTimestamp = data.initiatedTimestamp
                ? new Date(data.initiatedTimestamp).getTime()
                : null;
            const completedTimestamp = data.fulfil
                ? new Date(data.fulfil.body.completedTimestamp).getTime()
                : null;


            let fxQuoteRow = null;
            if(data.fxQuoteRequest){
                fxQuoteRow = {
                    redis_key: key,
                    conversion_request_id: data.fxQuoteRequest.body.conversionRequestId,
                    conversion_id : data.fxQuoteRequest.body.conversionTerms.conversionId,
                    determining_transfer_id: data.fxQuoteRequest.body.conversionTerms.determiningTransferId,
                    initiating_fsp: '',
                    counter_party_fsp: '',
                    amount_type:'',
                    source_amount:data.fxQuoteRequest.body.conversionTerms.sourceAmount.amount,
                    source_currency:data.fxQuoteRequest.body.conversionTerms.sourceAmount.currency,
                    target_amount:'',
                    target_currency:data.fxQuoteRequest.body.conversionTerms.targetAmount.currency,
                    expiration:'',
                    condition:'',
                    direction: data.direction,
                    raw: JSON.stringify(data),
                    created_at: initiatedTimestamp,
                    completed_at: completedTimestamp,
                    success: getInboundTransferStatus(data)
                };
            }
            else{
                logger.log('fxQuoteRequest not present on ',key);
            }
            if(data.fxQuoteResponse){
                let fxQuoteBody = (data.fxQuoteResponse.body);
                if(typeof fxQuoteBody === 'string')
                    fxQuoteBody = JSON.parse(fxQuoteBody);
                fxQuoteRow.conversion_id = fxQuoteBody.conversionTerms.conversionId;
                fxQuoteRow.initiating_fsp = fxQuoteBody.conversionTerms.initiatingFsp;
                fxQuoteRow.counter_party_fsp = fxQuoteBody.conversionTerms.counterPartyFsp;
                fxQuoteRow.amount_type = fxQuoteBody.conversionTerms.amountType;
                fxQuoteRow.source_amount = fxQuoteBody.conversionTerms.sourceAmount.amount;
                fxQuoteRow.source_currency = fxQuoteBody.conversionTerms.sourceAmount.currency;
                fxQuoteRow.target_amount = fxQuoteBody.conversionTerms.targetAmount.amount;
                fxQuoteRow.target_currency = fxQuoteBody.conversionTerms.targetAmount.currency;
                fxQuoteRow.expiration = fxQuoteBody.conversionTerms.expiration;
                fxQuoteRow.condition = fxQuoteBody.condition;
            }
            else{
                logger.log('fxQuoteRequest not present on ',key);
            }

            let fxTransferRow = null;
            if(data.fxPrepare)
                fxTransferRow = {
                    redis_key: key,
                    commit_request_id: data.fxPrepare.body.commitRequestId,
                    determining_transfer_id: data.fxPrepare.body.determiningTransferId,
                    initiating_fsp:data.fxPrepare.body.initiatingFsp,
                    counter_party_fsp: data.fxPrepare.body.counterPartyFsp,
                    amount_type: data.fxPrepare.body.amountType,
                    source_amount: data.fxPrepare.body.sourceAmount.amount,
                    source_currency: data.fxPrepare.body.sourceAmount.currency,
                    target_amount: data.fxPrepare.body.targetAmount.amount,
                    target_currency: data.fxPrepare.body.targetAmount.currency,
                    condition: data.fxPrepare.body.condition,
                    expiration: data.fxPrepare.body.expiration,
                    conversion_state: '', // if no fulfil leave empty
                    fulfilment: '', // if no fulfil leave empty
                    direction: data.direction,
                    created_at: initiatedTimestamp,
                    completed_timestamp: completedTimestamp,
                };
            else{
                logger.log('fxPrepare not present in ', key);
            }
            if(data.fulfil){
                fxTransferRow.fulfilment = data.fulfil.body.fulfilment;
                fxTransferRow.conversion_state = data.fulfil.body.conversionState;
            }
            else{
                logger.log('fulfil not present in ', key);
            }

            try {
                const keyIndex = cachedPendingKeys.indexOf(fxQuoteRow.redis_key);
                if(keyIndex === -1){
                    if(fxQuoteRow !== undefined && fxQuoteRow !== null)
                        await db('fx_quote').insert(fxQuoteRow);
                    if(fxTransferRow!== undefined && fxTransferRow!== null)
                        await db('fx_transfer').insert(fxTransferRow);
                    cachedPendingKeys.push(fxQuoteRow.redis_key);
                }
                else{
                    if(fxQuoteRow!= null && fxQuoteRow!= undefined) {
                        try {
                            await db('fx_quote').where({redis_key: fxQuoteRow.redis_key}).update(fxQuoteRow);
                        } catch (err) {
                            console.log(err);
                        }
                    }
                    if(fxTransferRow!= undefined && fxTransferRow!= null) {
                        try {
                            await db('fx_transfer').where({redis_key: fxTransferRow.redis_key}).update(fxTransferRow);
                        } catch (err) {
                            console.log(err);
                        }
                    }
                }
                if (fxQuoteRow.success !== null) {
                    cachedFulfilledKeys.push(key);
                }
            } catch (err) {
                console.log(err);
            }

        }


    // const sqlRaw = db('transfer').insert(row).toString();
    // db.raw(sqlRaw.replace(/^insert/i, 'insert or ignore')).then(resolve);
    };

    // Available key patterns in redis
    const redisKeys = ['transferModel_*', 'fxQuote_in_*'];
    redisKeys.forEach( async (key) => {
        const keys = await redisCache.keys(key);
        const uncachedOrPendingKeys = keys.filter(
            (x) => cachedFulfilledKeys.indexOf(x) === -1,
        );
        await Promise.all(uncachedOrPendingKeys.map(cacheKey));
    });

    // logger.log('In-memory DB sync complete');
}

const createMemoryCache = async (config) => {
    const knexConfig = {
        client: 'better-sqlite3',
        connection: {
            filename: ':memory:',
        },
        useNullAsDefault: true,
    };

    const db = knex(knexConfig);

    Object.defineProperty(
        db,
        'createTransaction',
        async () => new Promise((resolve) => db.transaction(resolve)),
    );

    await db.migrate.latest({ directory: `${__dirname}/migrations` });


    const redisCache = new Cache(config);
    await redisCache.connect();

    const doSyncDB = () =>
        syncDB({
            redisCache,
            db,
            logger: config.logger,
        });

    if (!config.manualSync) {
        await doSyncDB();
        const interval = setInterval(doSyncDB, (config.syncInterval || 60) * 1e3);
        db.stopSync = () => clearInterval(interval);
    } else {
        db.sync = doSyncDB;
    }
    db.redisCache = () => redisCache; // for testing purposes

    return db;
};

module.exports = {
    createMemoryCache,
    syncDB
};
