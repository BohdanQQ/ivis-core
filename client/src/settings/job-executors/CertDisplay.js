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
            <Panel title={t('Job Executor Certificates')}>
                <h3>CA Certificate</h3>
                <p>The certificate used to sign the client certificate of this IVIS core instance. Remote Executor must recognise this certificate authority.</p>
                <textarea value={ca}
                      disabled={true} style={textStyle} ></textarea>
                <br/>
                <br/>
                <h3>Executor Certificate</h3>
                <p>The certificate used to by remote executor to authenticate both like a client and a server.</p>
                <textarea value={cert}
                      disabled={true} style={textStyle} ></textarea>
                <br/>
                <br/>
                <h3>Executor Private Key</h3>
                <p>The private key corresponding to the Executor Certificate.</p>
                {
                    this.state.keyRevealed ? <textarea value={key} disabled={true} style={textStyle}></textarea> : <div></div>
                }
                <br/>
                <button onClick={() => this.toggleKeyVisibility()} >{this.state.keyRevealed ? t("Hide Key") : t("Reveal key")}</button>
            </Panel>
        );
    }
};
