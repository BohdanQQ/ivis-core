const config = require('../../../config');
const core = require("oci-core");
const identity = require("oci-identity");
const wr = require("oci-workrequests");
const common = require("oci-common");

if (!config.oci.credsPath || !config.oci.compartmentId || !config.oci.tenancyId) {
    module.exports = {
        computeClient: null,
        computeWaiter: null,
        virtualNetworkClient: null,
        virtualNetworkWaiter: null,
        identityClient: null,
        COMPARTMENT_ID: config.oci.compartmentId,
        TENANCY_ID: config.oci.tenancyId
    };
}
else {
    const OCI_CREDS_FILE_PATH = config.oci.credsPath;

    const authenticationDetailsProvider = new common.ConfigFileAuthenticationDetailsProvider(OCI_CREDS_FILE_PATH);
    const waiterFailAfterSeconds = 5 * 60;
    const delayMaxSeconds = 30;
    const waiterConfiguration = {
        terminationStrategy: new common.MaxTimeTerminationStrategy(waiterFailAfterSeconds),
        delayStrategy: new common.ExponentialBackoffDelayStrategy(delayMaxSeconds)
    };

    const computeClient = new core.ComputeClient({
        authenticationDetailsProvider: authenticationDetailsProvider
    });

    const workRequestClient = new wr.WorkRequestClient({
        authenticationDetailsProvider: authenticationDetailsProvider
    });

    const computeWaiter = computeClient.createWaiters(workRequestClient, waiterConfiguration);

    const virtualNetworkClient = new core.VirtualNetworkClient({
        authenticationDetailsProvider: authenticationDetailsProvider
    });

    const virtualNetworkWaiter = virtualNetworkClient.createWaiters(
        workRequestClient,
        waiterConfiguration
    );

    const identityClient = new identity.IdentityClient({
        authenticationDetailsProvider
    });

    module.exports = {
        computeClient,
        computeWaiter,
        virtualNetworkClient,
        virtualNetworkWaiter,
        identityClient,
        COMPARTMENT_ID: config.oci.compartmentId,
        TENANCY_ID: config.oci.tenancyId
    };
}
