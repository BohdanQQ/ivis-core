const knex = require('../../../knex');
const { MachineTypes } = require('../../../../../shared/remote-run');
const EXECUTOR_TYPE = MachineTypes.OCI_BASIC;
const GLOBAL_EXEC_STATE_TABLE = 'global_executor_type_state';

function getNextAvailableIpRange(ipsUsed) {
    let expectedIndex = 1;
    for (const { index } of ipsUsed) {
        if (index !== expectedIndex) {
            return { index: expectedIndex };
        }
        expectedIndex++;
    }
    if (expectedIndex === 255) {
        return null;
    }
    return { index: expectedIndex };
}

async function getIPsUsed() {
    return await knex.transaction(async tx => {
        const json = (await tx(GLOBAL_EXEC_STATE_TABLE).where('type', EXECUTOR_TYPE).first()).state;
        if (!json) {
            throw new Error(`State for executor of type ${EXECUTOR_TYPE} not found`);
        }
        const entity = JSON.parse(json);
        let ipsUsed = entity.ipsUsed || [];
        ipsUsed.sort((a, b) => a.index - b.index);
        return ipsUsed;
    });
}

function createStateForDb(ipsUsed) {
    if (!(ipsUsed instanceof Array)) {
        throw new Error(`Attempt to create invalid state with ipsUsed: ${ipsUsed}`);
    }
    return JSON.stringify({
        ipsUsed
    });
}

async function storeIPsUsed(ipsUsed) {
    return await knex.transaction(async tx => {
        await tx(GLOBAL_EXEC_STATE_TABLE).where('type', EXECUTOR_TYPE).update('state', createStateForDb(ipsUsed));
    });
}

async function createNewPoolParameters() {
    let ipsUsed = await getIPsUsed();
    const ipRange = getNextAvailableIpRange(ipsUsed);
    if (ipRange === null) {
        throw new Error("Dedicated IP address space depleted");
    }

    ipsUsed.push(ipRange);
    await storeIPsUsed(ipsUsed);

    return {
        subnetMask: `11.0.${ipRange.index}.0/24`
    };
}

async function registerPoolRemoval({ subnetMask }) {
    const searchResult = /^11\.0\.(?<index>[0-9]{1,3})\.0\/24$/g.exec(subnetMask);
    if (searchResult === null || !searchResult.groups || !searchResult.groups.index) {
        throw Error(`Invalid subnetMask provided: ${subnetMask}`);
    }

    const indexToRemove = Number.parseInt(searchResult.groups.index);
    if (indexToRemove <= 0 || indexToRemove >= 255) {
        throw Error(`Invalid subnetMask provided: ${subnetMask}`);
    }
    let ipsUsed = await getIPsUsed();
    ipsUsed = ipsUsed.filter((x) => x.index != indexToRemove);
    await storeIPsUsed(ipsUsed);
}

module.exports = {
    createNewPoolParameters,
    registerPoolRemoval
}