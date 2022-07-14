'use strict';

import React, {Component} from "react";
import PropTypes from "prop-types";
import {LinkButton, requiresAuthenticatedUser, Toolbar, withPageHelpers} from "../../lib/page";
import {
    Button,
    ButtonRow,
    Dropdown,
    Fieldset,
    filterData,
    Form,
    FormSendMethod,
    InputField,
    TextArea,
    withForm,
    withFormErrorHandlers
} from "../../lib/form";
import "brace/mode/json";
import "brace/mode/jsx";
import "brace/mode/scss";
import {withAsyncErrorHandler, withErrorHandling} from "../../lib/error-handling";
import {NamespaceSelect, validateNamespace} from "../../lib/namespace";
import {DeleteModalDialog, ImportExportModalDialog} from "../../lib/modals";
import {Panel} from "../../lib/panel";
import ivisConfig from "ivisConfig";
import { getChoosableExecutorTypes } from './executorTypes';
import ParamTypes from "../ParamTypes"
import axios from '../../lib/axios';
import {getUrl} from "../../lib/urls";
import {withComponentMixins} from "../../lib/decorator-helpers";
import {withTranslation} from "../../lib/i18n";

import styles from "../../lib/styles.scss";

const EPARAMS_KEY = 'execParams';

@withComponentMixins([
    withTranslation,
    withForm,
    withErrorHandling,
    withPageHelpers,
    requiresAuthenticatedUser
])
export default class CUD extends Component {
    constructor(props) {
        super(props);

        this.state = {
            builtinTasks: null,
            importExportModalShown: false
        };

        this.initForm({
            onChangeBeforeValidation: ::this.onChangeBeforeValidation,
            onChange: {
                type: ::this.onExecTypeChange,
            }
        });

        this.paramTypes = new ParamTypes(props.t);
    }

    static propTypes = {
        action: PropTypes.string.isRequired,
        entity: PropTypes.object
    };

    @withAsyncErrorHandler
    async fetchMachineTypeParams(type) {
        const result = await axios.get(getUrl(`rest/job-executor-params/${type}`));

        this.updateFormValue(EPARAMS_KEY, result.data);
    }

    @withAsyncErrorHandler
    async unsetMachineParamTypes() {
        this.updateFormValue(EPARAMS_KEY, {});
        this.state.formState.setIn(['data', 'type', 'value'], CUD.NOTHING_SELECTED_TYPE);
        this.state.formState.setIn(['data', 'parameters', 'value'], {});
    }

    onExecTypeChange(state, key, oldVal, newVal) {
        if (oldVal !== newVal) {
            const type = state.formState.getIn(['data', 'type', 'value']);

            if (type && type !== CUD.NOTHING_SELECTED_TYPE) {
                this.fetchMachineTypeParams(type);
            }
            else {
                this.unsetMachineParamTypes();
            }
        }
    }

    componentDidMount() {
        if (this.props.entity) {
            this.getFormValuesFromEntity(this.props.entity);
        } else {
            this.populateFormValues({
                name: '',
                description: '',
                namespace: ivisConfig.user.namespace,
                hostname: '',
                ip_address: null,
                type: CUD.NOTHING_SELECTED_TYPE
            });
        }
    }

    onChangeBeforeValidation(mutStateData, key, oldVal, newVal) {
        if (key === EPARAMS_KEY) {
            if (oldVal !== newVal && newVal) {
                this.paramTypes.adopt(newVal, mutStateData);
            }
        } else {
            const configSpec = mutStateData.getIn([EPARAMS_KEY, 'value']);
            if (configSpec) {
                this.paramTypes.onChange(configSpec, mutStateData, key, oldVal, newVal);
            }
        }
    }


    localValidateFormValues(state) {
        const t = this.props.t;

        if (!state.getIn(['name', 'value'])) {
            state.setIn(['name', 'error'], t('Name must not be empty'));
        } else {
            state.setIn(['name', 'error'], null);
        }

        if (!state.getIn(['ip_address', 'value'])) {
            state.setIn(['ip_address', 'error'], t('IP address must not be empty'));
        } else {
            state.setIn(['ip_address', 'error'], null);
        }

        const type = state.getIn(['type', 'value']);
        if (!type || type === CUD.NOTHING_SELECTED_TYPE) {
            state.setIn(['type', 'error'], t('Type must be selected'));
        } else {
            state.setIn(['type', 'error'], null);
        }

        const paramPrefix = this.paramTypes.getParamPrefix();
        for (const paramId of state.keys()) {
            if (paramId.startsWith(paramPrefix)) {
                state.deleteIn([paramId, 'error']);
            }
        }

        const configSpec = state.getIn([EPARAMS_KEY, 'value']);
        if (configSpec) {
            this.paramTypes.localValidate(configSpec, state);
        }

        validateNamespace(t, state);
    }

    getFormValuesMutator(data) {
        // EPARAMS_KEY dependency
        // might need params
        this.paramTypes.setFields(data.execParams, data.parameters, data);
    }

    submitFormValuesMutator(data) {
        if (this.props.entity) {
            data.settings = this.props.entity.settings;
        }

        // EPARAMS_KEY dependency
        data.parameters = {};
        if (data.execParams) {
            data.parameters = this.paramTypes.getParams(data.execParams, data);
        }

        return filterData(data, [
            'name',
            'description',
            'type',
            'hostname',
            'ip_address',
            'parameters',
            'namespace',
        ]);
    }

    @withFormErrorHandlers
    async submitHandler(submitAndLeave) {
        const t = this.props.t;

        const typeNow = this.getFormValue('type');
        if (typeNow && typeNow !== CUD.NOTHING_SELECTED_TYPE && !this.getFormValue(EPARAMS_KEY)) {
            this.setFormStatusMessage('warning', t('Machine type parameters are not selected. Wait for them to get displayed and then fill them in.'));
            return;
        }

        let sendMethod, url;
        if (this.props.entity) {
            sendMethod = FormSendMethod.PUT;
            url = `rest/job-executors/${this.props.entity.id}`
        } else {
            sendMethod = FormSendMethod.POST;
            url = 'rest/job-executors'
        }

        try {
            this.disableForm();
            this.setFormStatusMessage('info', t('Saving ...'));

            const submitResult = await this.validateAndSendFormValuesToURL(sendMethod, url);


            if (submitResult) {
                if (this.props.entity) {
                    if (submitAndLeave) {
                        this.navigateToWithFlashMessage('/settings/job-executors', 'success', t('Job executor updated'));
                    } else {
                        await this.getFormValuesFromURL(`rest/job-executors/${this.props.entity.id}`);
                        this.enableForm();
                        this.setFormStatusMessage('success', t('Job executor updated'));
                    }
                } else {
                    if (submitAndLeave) {
                        this.navigateToWithFlashMessage('/settings/job-executors', 'success', t('Job executor saved'));
                    } else {
                        this.navigateToWithFlashMessage(`/settings/job-executors/${submitResult}/edit`, 'success', t('Job executor saved'));
                    }
                }
            } else {
                this.enableForm();
                this.setFormStatusMessage('warning', t('There are errors in the form. Please fix them and submit again.'));
            }
        } catch (error) {
            throw error;
        }
    }

    static NOTHING_SELECTED_TYPE = 'NONE';
    static getExecTypeOptions(t) {
        let states = getChoosableExecutorTypes(t);
        const typeOptions = [{key: CUD.NOTHING_SELECTED_TYPE, label: t('Please select')}];
        for (let key in states) {
            if (states.hasOwnProperty(key)) {
                typeOptions.push({key: key, label: states[key]})
            }
        }

        return typeOptions;
    }

    render() {
        const t = this.props.t;
        const isEdit = !!this.props.entity;
        const canDelete = isEdit && this.props.entity.permissions.includes('delete');

        let executorTypeOptions = CUD.getExecTypeOptions(t);

        const configSpec = this.getFormValue(EPARAMS_KEY);
        const params = configSpec ? this.paramTypes.render(configSpec, this, false) : null;

        let title = 'Add Job Executor'
        if (isEdit) {
            title = t('Job Executor Settings');
        }
        return (
            <Panel title={title}>
                <ImportExportModalDialog
                    visible={this.state.importExportModalShown}
                    onClose={() => {
                        this.setState({importExportModalShown: false});
                    }}
                    onExport={() => {
                        const data = this.getFormValues();
                        const params = this.paramTypes.getParams(configSpec, data);
                        return JSON.stringify(params, null, 2);
                    }}
                    onImport={code => {
                        const data = {};
                        this.paramTypes.setFields(configSpec, code, data);
                        this.populateFormValues(data);
                        this.setState({importExportModalShown: false});
                    }}
                />
                {canDelete &&
                <DeleteModalDialog
                    stateOwner={this}
                    visible={this.props.action === 'delete'}
                    deleteUrl={`rest/job-executors/${this.props.entity.id}`}
                    backUrl={`/settings/job-executors/${this.props.entity.id}/edit`}
                    successUrl="/settings/job-executors"
                    deletingMsg={t('Deleting job executor ...')}
                    deletedMsg={t('Job executor deleted')}/>
                }

                <Form stateOwner={this} onSubmitAsync={::this.submitHandler}>
                    <InputField id="name" label={t('Name')} disabled={false}/>
                    <TextArea id="description" label={t('Description')} help={t('HTML is allowed')}
                              disabled={false}/>

                
                    <InputField id="hostname" label={t('Hostname')} disabled={false}/>
                    <InputField id="ip_address" label={t('IP Address')} disabled={false}/>

                    <Dropdown id="type" label={t('Executor Type')} options={executorTypeOptions}  disabled={false}/>
                    <NamespaceSelect/>

                    {configSpec ?
                        params &&
                        <Fieldset label={
                            <div>
                                <Toolbar className={styles.fieldsetToolbar}>
                                    <Button className="btn-primary" label={t('Import / Export')}
                                            onClickAsync={async () => this.setState({importExportModalShown: true})}/>
                                </Toolbar>
                                <span>{t('Job executor parameters')}</span>
                            </div>
                        }>
                            {params}
                        </Fieldset>
                        :
                        this.getFormValue("type") !== CUD.NOTHING_SELECTED_TYPE &&
                        <div className="alert alert-info" role="alert">{t('Loading parameter config...')}</div>
                    }

                    <ButtonRow>
                        <Button type="submit" className="btn-primary" icon="check" label={t('Save')}/>
                        <Button type="submit" className="btn-primary" icon="check" label={t('Save and leave')}
                                onClickAsync={async () => await this.submitHandler(true)}/>
                        {canDelete &&
                        <LinkButton
                            className="btn-danger"
                            icon="trash-alt"
                            label={t('Delete')}
                            to={`/settings/job-executors/${this.props.entity.id}/delete`}
                        />}
                    </ButtonRow>
                </Form>
            </Panel>
        );
    }
}
