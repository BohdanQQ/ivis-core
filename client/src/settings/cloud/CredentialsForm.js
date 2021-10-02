'use strict';

import React, {Component} from "react";
import PropTypes from 'prop-types';
import axios from "axios";
import {getUrl} from "../../lib/urls";
import { requiresAuthenticatedUser, withPageHelpers} from "../../lib/page";
import {
    Button,
    ButtonRow,
    filterData,
    Form,
    FormSendMethod,
    InputField,
    withForm,
    withFormErrorHandlers
} from "../../lib/form";
import {withErrorHandling} from "../../lib/error-handling";
import {withComponentMixins} from "../../lib/decorator-helpers";
import {withTranslation} from "../../lib/i18n";

/**
 * Note: This is not a Panel component!
 */
@withComponentMixins([
    withTranslation,
    withForm,
    withErrorHandling,
    withPageHelpers,
    requiresAuthenticatedUser
])
export default class CredentialsForm extends Component {

    constructor(props) {
        super(props);

        this.state = {helpShown: false};

        this.initForm({
            serverValidation: {
                url: 'rest/cloud_services-validate',
                changed: props.description.fields.map(fieldDesc => fieldDesc.name),
                extra: ['id']
            }
        });
    }

    static propTypes = {
        description: PropTypes.object
    }

    componentDidMount() {
        this.mounted = true;
        if (this.props.description.fields) {
            // creating a dummy "entity"
            let values = {
                id: this.props.description.serviceId,
                hash: this.props.entityHash // for server-side consistency check
            };
            // inserting `field name: field value` pairs to be recognised as a form element
            this.props.description.fields.forEach(fieldDesc =>
                values[fieldDesc.name] = this.props.values[fieldDesc.name])
            this.getFormValuesFromEntity(values);
        } else {
            console.log("Malformed credential description:");
            console.log(this.props.description);
            throw new Error("The service credential description is malformed.");
        }
    }

    componenWillUnmount() {
        this.mounted = false;
    }

    localValidateFormValues(state) {
        const t = this.props.t;

        // TODO: specialize as needed by other platforms
        for (const {type, name} of this.props.description.fields) {
            const formValue = state.getIn([name, 'value'])
            if (!formValue) {
                state.setIn([name, 'error'], t('No field can be empty'));
            } else {
                state.setIn([name, 'error'], null);
            }
        }
    }

    submitFormValuesMutator(data) {
        return filterData(data, this.props.description.fields.map(fieldDesc => fieldDesc.name));
    }

    getFormValuesMutator(data) {
        return undefined;
    }

    @withFormErrorHandlers
    async submitHandler(submitAndLeave) {
        const t = this.props.t;

        const sendMethod = FormSendMethod.PUT;
        const url = `rest/cloud/${this.props.description.serviceId}`

        try {
            this.disableForm();
            this.setFormStatusMessage('info', t('Saving credentials ...'));

            const submitResult = await this.validateAndSendFormValuesToURL(sendMethod, url);

            // TODO: add submit and leave?

            if (submitResult) {
                await this.getFormValuesFromURL(`rest/cloud/${this.props.description.serviceId}`);
                this.enableForm();
                this.setFormStatusMessage('success', t('Credentials udpated'));
            } else {
                this.enableForm();
                this.setFormStatusMessage('warning', t('There are errors in the form. Please fix them and submit again.'));
            }
        } catch (error) {
            this.enableForm();

            console.log(error);

            throw error;
        }
    }

    toggleShowHelp() {
        this.setState((prevstate) => {return {helpShown: !prevstate.helpShown};});
    }

    checkCredentials() {
        const t = this.props.t;
        const {serviceId, check} = this.props.description;
        let {proxyRequest} = check;
        this.setFormStatusMessage('info', t('Checking credentials ...'));

        axios.post(getUrl(`rest/cloud/${serviceId}/proxy/${proxyRequest}`))
            .then(response => response.data.ok)
            .catch(() => false)
            .then(areCredsValid => {
                if(!this.mounted)
                    return;
                if(areCredsValid) {
                    this.setFormStatusMessage('success', t('Credentials verified!'));
                }
                else {
                    this.setFormStatusMessage('warning', t('Credentials are either incorrect, the service is unavailable ' +
                        'or the server does not provide full support to this cloud service!'));
                }
            });
    }

    render() {

        const t = this.props.t;
        const {serviceId, fields, helpHTML} = this.props.description;
        const showHelp = this.state.helpShown;

        return (
            <>
            <Form stateOwner={this} onSubmitAsync={::this.submitHandler}>
                <InputField key="id" id="id" type="hidden" value={this.props.description.serviceId}/>
                {
                    fields.map(fieldDesc => <InputField key={fieldDesc.name} id={fieldDesc.name} label={t(fieldDesc.label)} type={fieldDesc.type}/>)
                }

                <ButtonRow>
                    <Button type="submit" className="btn-primary" icon="check" label={t('Save')}/>
                    <span  onClick={() => this.checkCredentials()}>
                        <Button type="button" className="btn-primary" icon="plug" label={t('Check Credentials')}/>
                    </span>
                </ButtonRow>

            </Form>

            <Button type="button" className="btn-primary" icon="question" label={t(showHelp ? 'Hide Help' : 'Show Help')}
                    onClickAsync={() => this.toggleShowHelp()}/>

            {
                // TODO: safer injection (XSS)
                showHelp && <div dangerouslySetInnerHTML={{__html: helpHTML}} />
            }
            </>
        );
    }
};
