const axios = require('axios').default; //for parameter typings

class TokenProvider {
    constructor(clientId, tenantId, clientSecret) {
        this.clientId = clientId;
        this.tenantId = tenantId;
        this.clientSecret = clientSecret;
    }

    getToken(scope)
    {
        const encodeGetParams = p => Object.entries(p).map(kv => kv.map(encodeURIComponent).join("=")).join("&");
        const authUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`
        const bodyParams = {
            client_id: this.clientId,
            scope: scope,
            client_secret: this.clientSecret,
            grant_type: 'client_credentials'
        };

        return axios.post(authUrl, encodeGetParams(bodyParams)).then(response => response.data);
    }
}

/**
 * Handles PUT operations over the Azure REST API which are asynchronous (provisioning state = "Updating", etc.)
 * @returns {Promise<{cancelled: boolean, data : object}>} bool: cancelled, object: any data created by initial response
 * @param {*} headers
 */
function handleAsyncPut(url, body, config, resolveIndicator) {
    return _handleAsyncOperation(axios.put(url, body, config), config, resolveIndicator);
}

/**
 * Handles POST operations over the Azure REST API which are asynchronous (provisioning state = "Updating", etc.)
 * @returns {Promise<{cancelled: boolean, data : object}>} bool: cancelled, object: any data created by initial response
 */
function handleAsyncPost(url, body, config, resolveIndicator) {
    return _handleAsyncOperation(axios.post(url, body, config), config, resolveIndicator);
}

/**
 * Handles DELETE operations over the Azure REST API which are asynchronous (provisioning state = "Updating", etc.)
 * @returns {Promise<{cancelled: boolean, data : object}>} bool: cancelled, object: any data created by initial response
 */
function handleAsyncDelete(url, config, resolveIndicator) {
    return _handleAsyncOperation(axios.delete(url, config), config, resolveIndicator);
}



/**
 * Handles operations over the Azure REST API which are asynchronous (provisioning state = "Updating", etc.)
 * @returns {Promise<{cancelled: boolean, data : object}>} bool: cancelled, object: any data created by initial response
 * @param {*} config
 */
function _handleAsyncOperation(promise, config, resolveIndicator) {
    return promise
        .then(response => {
            if(response.headers['azure-asyncoperation'] || response.headers['location'])
            {
		let asyncOpNullOrUndef = response.headers['azure-asyncoperation'] == null || response.headers['azure-asyncoperation'] == undefined;
		let loc = asyncOpNullOrUndef ? response.headers['location'] : response.headers['azure-asyncoperation'];
		let retryAfterNullOrUndef = response.headers['retry-after'] == null || response.headers['retry-after'] == undefined;
		let seconds = retryAfterNullOrUndef ? 10 : Number(response.headers['retry-after']);
                return _initiateStatusRefresh
                ({
                    location: loc,
                    retryAfterSeconds: seconds
                }, config, response.data);
            }
            else if (response.data && response.data.provisioningState)
            {
                if(['Succeeded', 'Cancelled'].find(i => i === response.data.provisioningState) !== undefined)
                    return Promise.resolve({cancelled: respose.data.status === 'Cancelled', data: response.data});
                else if(response.data.status === 'Failed')
                    return Promise.reject('Operation has failed');
                else
                    return Promise.reject('Unknown error (no asyncOperation or location headers)');
            }
            else if (resolveIndicator && resolveIndicator(response))
                return Promise.resolve({cancelled: false, data: response.data});
            else
                return Promise.reject("Unknown error");
        });
}

async function getAuthHeaderObj(tokenProvider, scope) {
    return {
        headers: { Authorization: `Bearer ${(await (tokenProvider.getToken(scope))).access_token}` }
    };
}

function _initiateStatusRefresh({location, retryAfterSeconds}, config, data) {
    return new Promise(resolve => setTimeout(() => resolve(location), retryAfterSeconds * 1000))
        .then(location => axios.get(location, config))
        .then(response => {
            if(['Succeeded', 'Cancelled'].find(i => i === response.data.status) !== undefined)
                return Promise.resolve({cancelled: response.data.status === 'Cancelled', data});
            else if(response.data.status === 'Failed')
                return Promise.reject('Operation has failed');
            else
                return _initiateStatusRefresh({location, retryAfterSeconds}, config, data);

        });
}

module.exports.handleAsyncPut = handleAsyncPut;
module.exports.handleAsyncPost = handleAsyncPost;
module.exports.handleAsyncDelete = handleAsyncDelete;
module.exports.TokenProvider = TokenProvider;
module.exports.getAuthHeaderObj = getAuthHeaderObj;
