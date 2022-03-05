const {getAuthHeaderObj} = require('./basics');
const axios = require('axios').default; //for parameter typings
const scope = 'https://management.azure.com/.default';

/**
 * Retrieve all data from a url. Data is supposed to be iterable!
 * Follows the `nextLink` property until the end.
 * @note As to whether to use this function, refer to the MS Azure REST API documentation; if the nextLink is a defined property of the data returned by the API endpoint, you should use this function
 * @param url url to GET data from
 * @param headers axios configuration
 * @param extractor function to be applied on received data, must return an iterable object
 * @param target an array to which filtered objects will be inserted into
 * @param filter a predicate accepting an object obtained by iterating the return value of `extractor`
 * @private
 */
async function _continueLink(url, headers, extractor, target, filter = false) {
    const data = await axios.get(url, headers).then(response => response.data);

    for (const obj of extractor(data)) {
        if (filter) {
            if (filter(obj)) {
                target.push(obj);
            }
        } else {
            target.push(obj);
        }
    }
    ;

    if (data.nextLink)
        await _continueLink(data.nextLink, headers, extractor, target, filter);
    return;
}

async function getSubscriptions(tokenProvider) {
    let result = [];
    await _continueLink('https://management.azure.com/subscriptions?api-version=2020-01-01', await getAuthHeaderObj(tokenProvider, scope), obj => obj.value,
        result);
    return result;
}

async function getLocationList(subscriptionId, tokenProvider) {
    let skus = [];
    const header = await getAuthHeaderObj(tokenProvider, scope);
    const locationDescriptions = await axios.get(`https://management.azure.com/subscriptions/${subscriptionId}/locations?api-version=2020-01-01`, header)
        .then(response => response.data.value);
    await _continueLink(`https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Compute/skus?api-version=2021-07-01`, header,
        obj => obj.value, skus, obj => obj.resourceType === "virtualMachines");

    let locationNames = [];

    for (const sku of skus) {
        for (const location of sku.locations) {
            if (locationNames.indexOf(location.toLowerCase()) === -1)
                locationNames.push(location.toLowerCase());
        }
    }

    locationNames = locationNames.filter((name) => locationDescriptions.find((loc => loc.name === name)));
    return locationNames.map(name => {
        const found = locationDescriptions.find((loc => loc.name === name)).displayName;
        let retFound = (found == null || found == undefined) ? 'No name found' : found; 
	return [retFound, name];
    });
}

async function getVmSizes(subscriptionId, location, tokenProvider) {
    return await axios.get(`https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Compute/locations/${location}/vmSizes?api-version=2021-07-01`,
        await getAuthHeaderObj(tokenProvider, scope))
        .then(response => response.data);
}

module.exports.getSubscriptions = getSubscriptions;
module.exports.getLocationList = getLocationList;
module.exports.getVmSizes = getVmSizes;
