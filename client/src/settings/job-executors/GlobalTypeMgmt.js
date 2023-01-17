'use strict';

import React, { Component } from "react";
import { Table } from "../../lib/table";
import { Panel } from "../../lib/panel";
import {
    requiresAuthenticatedUser,
    withPageHelpers
} from "../../lib/page";
import { Icon } from "../../lib/bootstrap-components";
import axios from "../../lib/axios";
import {
    withAsyncErrorHandler,
    withErrorHandling
} from "../../lib/error-handling";
import { getUrl } from "../../lib/urls";
import { withComponentMixins } from "../../lib/decorator-helpers";
import { withTranslation } from "../../lib/i18n";


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
    }

    @withAsyncErrorHandler
    async clean(table, type) {
        // TODO
        table.refresh();
    }

    render() {
        const t = this.props.t;
        const columns = [
            { data: 0, title: t('Executor Type') },
            { data: 1, title: t('Locked') },
            { data: 3, title: t('Namespace') },
            {
                actions: data => {
                    const actions = [];
                    actions.push({
                        label: <Icon icon="broom" family="fas" title={t('Clear global state')} />,
                        action: (table) => this.clean(table, data[0])
                    });

                    actions.push({
                        label: <Icon icon="file-alt" family="fas" title={t('Show Log')} />,
                        link: `/settings/job-executors/global/${data[0]}/log`
                    });

                    return { refreshTimeout: 1000, actions };
                }
            }
        ];


        return (
            <Panel title={t('Global Executor Type Management')}>
                <Table ref={node => this.table = node} withHeader dataUrl="rest/job-executor-types" columns={columns} refreshInterval={1000} />
            </Panel>
        );
    }
};
