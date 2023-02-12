'use strict';

import React, { Component } from "react";
import {
    requiresAuthenticatedUser,
    withPageHelpers
} from "../../lib/page";
import {
    withErrorHandling
} from "../../lib/error-handling";
import { withComponentMixins } from "../../lib/decorator-helpers";
import { withTranslation } from "../../lib/i18n";
import developStyles from "../tasks/Develop.scss";


@withComponentMixins([
    withTranslation,
    withErrorHandling,
    withPageHelpers,
    requiresAuthenticatedUser
])
export default class Log extends Component {
    constructor(props) {
        super(props);
    }

    render() {
        const t = this.props.t;
        let log = this.props.log;
        log = (!log || log.length === 0) ? t('logEmpty') : log;
        return (
            <>
                <div className={developStyles.integrationTabRunOutput}>
                    <pre>
                        <code>
                            {log}
                        </code>
                    </pre>
                </div>
            </>
        );
    }
}
