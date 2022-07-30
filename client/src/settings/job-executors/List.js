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
import {Icon} from "../../lib/bootstrap-components";
import {
    withAsyncErrorHandler,
    withErrorHandling
} from "../../lib/error-handling";
import {checkPermissions} from "../../lib/permissions";
import {
    tableAddDeleteButton,
    tableRestActionDialogRender,
    tableRestActionDialogInit
} from "../../lib/modals";
import {withComponentMixins} from "../../lib/decorator-helpers";
import {withTranslation} from "../../lib/i18n";
import { MachineTypes } from '../../../../shared/remote-run';

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
                    const perms = data[5];
                    const type = data[3];

                    if (type === MachineTypes.REMOTE_RUNNER_AGENT) {
                        actions.push({
                            label: <Icon icon="certificate" title={t('Display certificate data')}/>,
                            link: `/settings/job-executors/${data[0]}/certs`
                        });
                    }

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


                    return {actions};
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
