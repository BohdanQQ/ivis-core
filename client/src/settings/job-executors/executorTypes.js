'use strict';
import { MachineTypes } from "../../../../shared/remote-run";

export function getTranslatedExecutorTypes(t) {
    return {
        [MachineTypes.LOCAL]: t('jeExecTypeNameLocal'),
        [MachineTypes.REMOTE_RUNNER_AGENT]: t('jeExecTypeNameRJR'),
        [MachineTypes.OCI_BASIC]: t('jeExecTypeNameOCIBasic'),
        [MachineTypes.REMOTE_POOL]: t('jeExecTypeNameRPS'),
        [MachineTypes.SLURM_POOL]: t('jeExecTypeNameSLURM')
    }
}

export function getChoosableExecutorTypes(t) {
    const translatedTypes = getTranslatedExecutorTypes(t);
    delete translatedTypes[MachineTypes.LOCAL];
    return translatedTypes;
}
