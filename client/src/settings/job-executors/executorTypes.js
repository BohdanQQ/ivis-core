'use strict';
import { MachineTypes } from "../../../../shared/remote-run";

export function getChoosableExecutorTypes(t) {
    return {
        [MachineTypes.REMOTE_RUNNER_AGENT]: t('Remote Job Runner'),
        [MachineTypes.OCI_BASIC]: t('Homogenous Oracle Cloud Infrastructure Pool')
    }
}
