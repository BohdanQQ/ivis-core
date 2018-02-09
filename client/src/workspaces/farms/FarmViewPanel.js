'use strict';

import React, { Component } from "react";
import { translate } from "react-i18next";
import { Panel } from "../../lib/panel";
import { requiresAuthenticatedUser, withPageHelpers } from "../../lib/page";
import axios from "../../lib/axios";
import { withAsyncErrorHandler, withErrorHandling } from "../../lib/error-handling";
import moment from "moment";
import { LineChart } from "../../ivis-ws/LineChart";
import { TimeRangeSelector } from "../../ivis-ws/TimeRangeSelector";
import { TimeContext, withIntervalAccess } from "../../ivis-ws/TimeContext";
import { rgb } from "d3-color";
import { IntervalAbsolute } from "../../ivis-ws/TimeInterval";
import prepareDataFun from "../../lib/data/farm/prepareData";
import styles from "../Sample.scss";
import randomColor from '../../lib/random-color.js';

@translate()
@withPageHelpers
@withErrorHandling
@requiresAuthenticatedUser
export default class FarmPanel extends Component {
    constructor(props) {
        super(props);
        this.state = {
            config: {
                yScale: {
                    includedMin: 0,
                    includedMax: 100
                }
            },
            cropSeasonRanges: null
        };

        //this.colors = [rgb(70, 130, 180), rgb(170, 30, 80), rgb(70, 230, 10), rgb(17, 130, 100)];
    }

    @withAsyncErrorHandler
    async componentDidMount() {
        const t = this.props.t;
        const result = await axios.get(`/rest/farmsensors/${this.props.farm.id}`);
        const sensors = result.data;

        let signalSetsArray = [];
        let idxColor = 0;
        for (const sensor of sensors) {
            let signalSetDic = null;

            for (const ssd of signalSetsArray)
                if (ssd.cid === sensor.ssCid)
                    signalSetDic = ssd;

            if (signalSetDic === null) {
                signalSetDic = {};
                signalSetDic.cid = sensor.ssCid;
                signalSetDic.signals = [];
                signalSetsArray.push(signalSetDic);
            }

            signalSetDic.signals.push({
                cid: sensor.sCid,
                label: t(signalSetDic.cid + ':' + sensor.sCid),
                color: randomColor()
            });
        }

        const sigSets = {
            signalSets: signalSetsArray
        }
        let state = Object.assign(this.state.config, sigSets);
        const prepareData = {
            prepareData: prepareDataFun
        };

        state = Object.assign(this.state.config, prepareData);
        this.setState({ state });

        const resCropSeasons = await axios.get(`/rest/crop-seasons/farm/${this.props.farm.id}`);
                
        if(resCropSeasons.data.length > 0) {
            const cropSeasons = resCropSeasons.data;
            const refreshInterval = moment.duration(10, 'm');
            const aggregationInterval = null; /* auto */
            const moreRanges = [];
            for(const cs of cropSeasons) {
                moreRanges.push({ from: cs.start, to: cs.end, refreshInterval, 
                    aggregationInterval, 
                    label: t(cs.name + ' (' + cs.crop + ')') });
            }
            this.setState({cropSeasonRanges: moreRanges});
        }
    }

    render() {
        const t = this.props.t;
        const legendRows = [];

        if (this.state.config.signalSets) {
            for (const sigSetConf of this.state.config.signalSets) {
                for (const sigConf of sigSetConf.signals) {
                    legendRows.push(
                        <div>
                            <span className={styles.signalColor} style={{ backgroundColor: sigConf.color }}></span>
                            <span className={styles.signalLabel}>{sigConf.label}</span>
                        </div>
                    );
                }
            }
        }

        return (
            <Panel title={t(this.props.farm.name + '\'s Farm View')} >
                {(!!this.state.config.signalSets &&
                    this.state.config.signalSets.length > 0) &&
                    <TimeContext>
                        <div className="row">
                            <div className="col-xs-12">
                                <div className={styles.intervalChooser}>
                                    {!!this.state.cropSeasonRanges ?
                                    <TimeRangeSelector moreTimeRange={{title: 'Crop Seasons Time Ranges', ranges: this.state.cropSeasonRanges}} />
                                    :
                                    <TimeRangeSelector />
                                    }
                                </div>
                                <LineChart
                                    onClick={(selection, position) => { console.log(selection); console.log(position); }}
                                    config={this.state.config}
                                    height={500}
                                    margin={{ left: 40, right: 5, top: 5, bottom: 20 }}
                                />
                                <div className={styles.legend}>
                                    <div className="row">
                                        {legendRows}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </TimeContext>
                }
            </Panel>
        );
    }
}