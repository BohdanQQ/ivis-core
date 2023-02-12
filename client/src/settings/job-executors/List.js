'use strict';

import React, {Component} from "react";
import {Table} from "../../lib/table";
import {Panel} from "../../lib/panel";
import {
    LinkButton,
    requiresAuthenticatedUser,
    Toolbar,
    withPageHelpers
} from "../../lib/page";
import axiosWrapper from "../../lib/axios";
import {Icon} from "../../lib/bootstrap-components";
import {
    withAsyncErrorHandler,
    withErrorHandling
} from "../../lib/error-handling";
import {checkPermissions} from "../../lib/permissions";
import {
    tableAddDeleteButton,
    tableAddRestActionButtonWithDefaultErrorHandler,
    tableRestActionDialogRender,
    tableRestActionDialogInit
} from "../../lib/modals";
import {withComponentMixins} from "../../lib/decorator-helpers";
import {withTranslation} from "../../lib/i18n";
import { ExecutorStatus, MachineTypes } from '../../../../shared/remote-run';
import { getTranslatedExecutorTypes } from "./executorTypes";

@withComponentMixins([
    withTranslation,
    withErrorHandling,
    withPageHelpers,
    requiresAuthenticatedUser
])
export default class List extends Component {
    constructor(props) {
        super(props);
        this.state = {};
        tableRestActionDialogInit(this);
    }

    @withAsyncErrorHandler
    async fetchPermissions() {
        const result = await checkPermissions({
            createExec: {
                entityTypeId: 'namespace',
                requiredOperations: ['createExec']
            },
            types: { entityTypeId: 'namespace', requiredOperations: ['manageGlobalExecState'] }
        });

        this.setState({
            createPermitted: result.data.createExec,
            typesPermitted: result.data.types
        });
    }

    componentDidMount() {
        this.fetchPermissions();
    }

    render() {
        const t = this.props.t;

        const columns = [
            {data: 1, title: t('name')},
            {data: 2, title: t('description')},
            {data: 3, title: t('type'), render: (data) => getTranslatedExecutorTypes(t)[data]},
            {data: 4, title: t('namespace')},
            {
                actions: data => {
                    const actions = [];
                    const perms = data[data.length - 1];
                    const type = data[3];
                    const status = data[5];
                    
                    let refreshTimeout;
                    if (status === ExecutorStatus.PROVISIONING) {
                        actions.push({
                            label: <Icon icon="spinner" family="fas" title={t('provisioning')}/>
                        });

                        refreshTimeout = 2000;
                    } else {
                        actions.push({
                                label: <Icon icon={status === ExecutorStatus.READY ? "check" : "times"} family="fas" title={t(status === ExecutorStatus.READY ? 'ready' : 'failed')}/>
                            });
                    }

                    if (type === MachineTypes.REMOTE_RUNNER_AGENT) {
                        actions.push({
                            label: <Icon icon="certificate" title={t('displayCertificateData')}/>,
                            link: `/settings/job-executors/${data[0]}/certs`
                        });
                    }

                    actions.push({
                        label: <Icon icon="file-alt" family="far" title={t('jeViewExecLogs')} />,
                        link: `/settings/job-executors/${data[0]}/log`
                    });

                    if (perms.includes('edit')) {
                        actions.push({
                            label: <Icon icon="edit" title={t('settings')}/>,
                            link: `/settings/job-executors/${data[0]}/edit`
                        });
                    }

                    if (perms.includes('share')) {
                        actions.push({
                            label: <Icon icon="share" title={t('share')}/>,
                            link: `/settings/job-executors/${data[0]}/share`
                        });
                    }

                    tableAddDeleteButton(actions, this, perms, `rest/job-executors/${data[0]}`, data[1], t('jeDeletingExec'), t('jeDeletingBackground'));
                    
                    if (perms.includes('delete')) {
                        tableAddRestActionButtonWithDefaultErrorHandler(actions, this, {
                            method: axiosWrapper.delete,
                            url: `rest/job-executors/${data[0]}/force`,
                        }, {
                            icon: 'exclamation-triangle',
                            label: t('forceDelete'),
                        }, t('jeForceDeleteDesc'), t('jeForceDeleteAreYouAbsolutelySure'), t('jeDeletingExec'), t('jeDeleted'));
                    }
                    

                    return {refreshTimeout, actions};
                }
            }
        ];


        const dataUrl = "rest/job-exec-table";
        return (
            <Panel title={t('jeJobExecutors')}>
                {tableRestActionDialogRender(this)}
                {this.state.createPermitted &&
                    <Toolbar>
                        {
                            this.state.typesPermitted &&
                            <LinkButton to="/settings/job-executors/global" className="btn-primary" icon="wrench"
                                    label={t('jeGlobalExecTypeMgmtShorterForButton')}/>
                        }
                        <LinkButton to="/settings/job-executors/create" className="btn-primary" icon="plus"
                                label={t('jeCreateExec')}/>
                    </Toolbar>
                }
                <Table ref={node => this.table = node} withHeader dataUrl={dataUrl} columns={columns}/>
            </Panel>
        );
    }
};
