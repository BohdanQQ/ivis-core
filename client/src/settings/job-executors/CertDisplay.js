'use strict';

import React, {Component} from "react";
import PropTypes from "prop-types";
import {Panel} from "../../lib/panel";
import {
    requiresAuthenticatedUser, 
    withPageHelpers
} from "../../lib/page";
import {
    withErrorHandling
} from "../../lib/error-handling";
import {withComponentMixins} from "../../lib/decorator-helpers";
import {withTranslation} from "../../lib/i18n";


@withComponentMixins([
    withTranslation,
    withErrorHandling,
    withPageHelpers,
    requiresAuthenticatedUser
])
export default class CertDisplay extends Component {
    
    static propTypes = {
        entity: PropTypes.object.isRequired,
    }

    constructor(props) {
        super(props);
        this.state = {
            keyRevealed: false
        };
    }

    toggleKeyVisibility() {
        this.setState({keyRevealed: !this.state.keyRevealed });
    }

    render() {
        const t = this.props.t;
        const { ca, cert, key } = this.props.entity;

        const textStyle = {width: "100%", height: "15vh"};

        return (
            <Panel title={t('jeCerts')}>
                <h3>{t('jeCaCert')}</h3>
                <p>{t('jeCACertDescription')}</p>
                <textarea value={ca}
                      disabled={true} style={textStyle} ></textarea>
                <br/>
                <br/>
                <h3>{t('jeExecCert')}</h3>
                <p>{t('jeExecCertDescription')}</p>
                <textarea value={cert}
                      disabled={true} style={textStyle} ></textarea>
                <br/>
                <br/>
                <h3>{t('jeExecPrivKey')}</h3>
                <p>{t('jePrivKeyDesc')}</p>
                {
                    this.state.keyRevealed ? <textarea value={key} disabled={true} style={textStyle}></textarea> : <div></div>
                }
                <br/>
                <button onClick={() => this.toggleKeyVisibility()} >{this.state.keyRevealed ? t('hideKey') : t('revealKey')}</button>
            </Panel>
        );
    }
};
