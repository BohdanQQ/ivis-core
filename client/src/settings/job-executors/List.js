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
            }
        });

        this.setState({
            createPermitted: result.data.createExec
        });
    }

    componentDidMount() {
        this.fetchPermissions();
    }

    render() {
        const t = this.props.t;

        const columns = [
            {data: 1, title: t('Name')},
            {data: 2, title: t('Description')},
            {data: 3, title: t('Type')},
            {data: 4, title: t('Namespace')},
            {
                actions: data => {
                    const actions = [];
                    const perms = data[data.length - 1];
                    const type = data[3];
                    const status = data[5];
                    
                    let refreshTimeout;
                    if (status === ExecutorStatus.PROVISIONING) {
                        actions.push({
                            label: <Icon icon="spinner" family="fas" title={t('Provisioning')}/>
                        });

                        refreshTimeout = 2000;
                    } else {
                        actions.push({
                                label: <Icon icon={status === ExecutorStatus.READY ? "check" : "times"} family="fas" title={t(status === ExecutorStatus.READY ? "ready" : "failure")}/>
                            });
                    }

                    if (type === MachineTypes.REMOTE_RUNNER_AGENT) {
                        actions.push({
                            label: <Icon icon="certificate" title={t('Display certificate data')}/>,
                            link: `/settings/job-executors/${data[0]}/certs`
                        });
                    }

                    actions.push({
                        label: <Icon icon="file-alt" family="far" title={t('View executor log')} />,
                        link: `/settings/job-executors/${data[0]}/log`
                    });

                    if (perms.includes('edit')) {
                        actions.push({
                            label: <Icon icon="edit" title={t('Settings')}/>,
                            link: `/settings/job-executors/${data[0]}/edit`
                        });
                    }

                    if (perms.includes('share')) {
                        actions.push({
                            label: <Icon icon="share" title={t('Share')}/>,
                            link: `/settings/job-executors/${data[0]}/share`
                        });
                    }

                    tableAddDeleteButton(actions, this, perms, `rest/job-executors/${data[0]}`, data[1], t('Deleting job executor ...'), t('Job executor deleted'));
                    
                    if (perms.includes('delete')) {
                        tableAddRestActionButtonWithDefaultErrorHandler(actions, this, {
                            method: axiosWrapper.delete,
                            url: `rest/job-executors/${data[0]}/force`,
                        }, {
                            icon: 'exclamation-triangle',
                            label: 'Force Delete',
                        }, t('Forced Delete of a job executor'), t('This action is dangeous and could leak remote resources. Make sure you basolutely HAVE to do this.\n The only reason to execute this action is for example removal of a badly initialized/removed executor. Even then you have to make sure there are not any remote resources left to be destroyed/unallocated.\nAre you still ABSOLUTELY SURE you have to do this?'), t('Deleting job executor ...'), t('Job executor deleted'));
                    }
                    

                    return {refreshTimeout, actions};
                }
            }
        ];

        const dataUrl = "rest/job-exec-table";
        return (
            <Panel title={t('Job Executors')}>
                {tableRestActionDialogRender(this)}
                {this.state.createPermitted &&
                    <Toolbar>
                        <LinkButton to="/settings/job-executors/create" className="btn-primary" icon="plus"
                                label={t('Create Job Executor')}/>
                    </Toolbar>
                }
                <Table ref={node => this.table = node} withHeader dataUrl={dataUrl} columns={columns}/>
            </Panel>
        );
    }
};
