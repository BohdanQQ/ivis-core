const core = require('oci-core');
const identity = require('oci-identity');
const wr = require('oci-workrequests');
const common = require('oci-common');
const config = require('../../../config');

if (!config.oci.credsPath || !config.oci.compartmentId || !config.oci.tenancyId) {
    module.exports = {
        computeClient: null,
        getComputeWaiter: null,
        virtualNetworkClient: null,
        getVirtualNetworkWaiter: null,
        identityClient: null,
        COMPARTMENT_ID: config.oci.compartmentId,
        TENANCY_ID: config.oci.tenancyId,
    };
} else {
    const OCI_CREDS_FILE_PATH = config.oci.credsPath;

    const authenticationDetailsProvider = new common.ConfigFileAuthenticationDetailsProvider(OCI_CREDS_FILE_PATH);
    const waiterFailAfterSeconds = 5 * 60;
    const delayMaxSeconds = 30;

    const computeClient = new core.ComputeClient({
        authenticationDetailsProvider,
    });

    const workRequestClient = new wr.WorkRequestClient({
        authenticationDetailsProvider,
    });

    const getComputeWaiter = () => {
        const waiterConfiguration = {
            terminationStrategy: new common.MaxTimeTerminationStrategy(waiterFailAfterSeconds),
            delayStrategy: new common.ExponentialBackoffDelayStrategy(delayMaxSeconds),
        };

        return computeClient.createWaiters(workRequestClient, waiterConfiguration);
    } 

    const virtualNetworkClient = new core.VirtualNetworkClient({
        authenticationDetailsProvider,
    });

    const getVirtualNetworkWaiter = () => {
        const waiterConfiguration = {
            terminationStrategy: new common.MaxTimeTerminationStrategy(waiterFailAfterSeconds),
            delayStrategy: new common.ExponentialBackoffDelayStrategy(delayMaxSeconds),
        };

        return virtualNetworkClient.createWaiters(
            workRequestClient,
            waiterConfiguration,
        );
    };

    const identityClient = new identity.IdentityClient({
        authenticationDetailsProvider,
    });

    module.exports = {
        computeClient,
        getComputeWaiter,
        virtualNetworkClient,
        getVirtualNetworkWaiter,
        identityClient,
        COMPARTMENT_ID: config.oci.compartmentId,
        TENANCY_ID: config.oci.tenancyId,
        
    };
}
