'use strict';

import React, {Component} from "react";

import {translate} from "react-i18next";
import {TimeBasedChart, RenderStatus} from "./TimeBasedChart";
import {axisBottom, axisLeft} from "d3-axis";
import {scaleLinear, scaleTime} from "d3-scale";
import {bisector, max, min} from "d3-array";
import {event as d3Event, mouse, select} from "d3-selection";
import {brushX} from "d3-brush";
import {area, curveMonotoneX, line} from "d3-shape";
import {rgb} from "d3-color";
import {withIntervalAccess} from "./TimeContext";
import {dataAccess} from "./DataAccess";
import {withAsyncErrorHandler, withErrorHandling} from "../lib/error-handling";
import interoperableErrors from "../../../shared/interoperable-errors";
import PropTypes from "prop-types";
import {roundToMinAggregationInterval} from "../../../shared/signals";
import {IntervalSpec} from "./TimeInterval";
import {DataPathApproximator} from "./DataPathApproximator";
import tooltipStyles from "./Tooltip.scss";
import * as dateMath from "../lib/datemath";
import {Icon} from "../lib/bootstrap-components";
import {format as d3Format} from "d3-format";


class TooltipContent extends Component {
    constructor(props) {
        super(props);
    }

    static propTypes = {
        signalSetsConfig: PropTypes.array.isRequired,
        selection: PropTypes.object
    }

    render() {
        if (this.props.selection) {
            const rows = [];
            let ts;

            for (const sigSetConf of this.props.signalSetsConfig) {
                const sel = this.props.selection[sigSetConf.cid];

                if (sel) {
                    ts = sel.ts;
                    const numberFormat = d3Format('.3f');

                    for (const sigConf of sigSetConf.signals) {
                        const avg = numberFormat(sel.data[sigConf.cid].avg);
                        const min = numberFormat(sel.data[sigConf.cid].min);
                        const max = numberFormat(sel.data[sigConf.cid].max);

                        rows.push(
                            <div key={sigSetConf.cid + " " + sigConf.cid}>
                                <span className={tooltipStyles.signalColor} style={{color: sigConf.color}}><Icon icon="minus"/></span>
                                <span className={tooltipStyles.signalLabel}>{sigConf.label}:</span>
                                <span className={tooltipStyles.signalAvg}>Ø {avg}</span>
                                <span className={tooltipStyles.signalMinMax}><Icon icon="chevron-left" family="fa"/>{min} <Icon icon="ellipsis-h" family="fa"/> {max}<Icon icon="chevron-right" family="fa"/></span>
                            </div>
                        );
                    }
                }
            }

            return (
                <div>
                    <div className={tooltipStyles.time}>{dateMath.format(ts)}</div>
                    {rows}
                </div>
            );

        } else {
            return null;
        }
    }
}


const SelectedState = {
    HIDDEN: 0,
    VISIBLE: 1,
    SELECTED: 2
};


@translate()
export class LineChart extends Component {
    constructor(props){
        super(props);

        const t = props.t;

        this.avgLinePathSelection = {};
        this.areaPathSelection = {};
        this.avgLinePointsSelection = {};

        // This serves to remember the selection state for each point (circle).
        // This way, we can minimize the number of attr calls which are actually quite costly in terms of style recalculation
        this.avgLinePointsSelected = {};

        this.boundCreateChart = ::this.createChart;
        this.boundGetGraphContent = ::this.getGraphContent;
    }

    static propTypes = {
        config: PropTypes.object.isRequired,
        contentComponent: PropTypes.func,
        contentRender: PropTypes.func,
        onClick: PropTypes.func,
        height: PropTypes.number,
        margin: PropTypes.object,
        withTooltip: PropTypes.bool,
        withBrush: PropTypes.bool,
        tooltipContentComponent: PropTypes.func,
        tooltipContentRender: PropTypes.func
    }

    static defaultProps = {
        margin: { left: 40, right: 5, top: 5, bottom: 20 },
        height: 500,
        withTooltip: true,
        withBrush: true
    }

    createChart(base, xScale) {
        const self = this;
        const width = base.renderedWidth;
        const abs = base.getIntervalAbsolute();
        const config = this.props.config;

        const points = {};
        let yMin, yMax;

        const yScaleConfig = config.yScale || {};
        yMin = yScaleConfig.includedMin;
        yMax = yScaleConfig.includedMax;

        let noData = true;

        for (const sigSetConf of config.signalSets) {
            const {prev, main, next} = base.state.signalSetsData[sigSetConf.cid];

            let pts;

            if (main.length > 0) {
                pts = main.slice();

                if (prev) {
                    const prevInterpolated = {
                        ts: abs.from,
                        data: {}
                    };

                    for (const sigConf of sigSetConf.signals) {
                        prevInterpolated.data[sigConf.cid] = {};

                        for (const agg of ['min', 'avg', 'max']) {
                            const delta = (abs.from - prev.ts) / (pts[0].ts - prev.ts);
                            prevInterpolated.data[sigConf.cid][agg] = prev.data[sigConf.cid][agg] * (1 - delta) + pts[0].data[sigConf.cid][agg] * delta;
                        }
                    }

                    pts.unshift(prevInterpolated);
                }

                if (next) {
                    const nextInterpolated = {
                        ts: abs.to,
                        data: {}
                    };

                    for (const sigConf of sigSetConf.signals) {
                        nextInterpolated.data[sigConf.cid] = {};

                        for (const agg of ['min', 'avg', 'max']) {
                            const delta = (next.ts - abs.to) / (next.ts - pts[pts.length - 1].ts);
                            nextInterpolated.data[sigConf.cid][agg] = next.data[sigConf.cid][agg] * (1 - delta) + pts[pts.length - 1].data[sigConf.cid][agg] * delta;
                        }
                    }

                    pts.push(nextInterpolated);
                }

            } else if (main.length === 0 && prev && next) {
                const prevInterpolated = {
                    ts: abs.from,
                    data: {}
                };

                const nextInterpolated = {
                    ts: abs.to,
                    data: {}
                };

                for (const sigConf of sigSetConf.signals) {
                    prevInterpolated.data[sigConf.cid] = {};
                    nextInterpolated.data[sigConf.cid] = {};

                    for (const agg of ['min', 'avg', 'max']) {
                        const deltaFrom = (abs.from - prev.ts) / (next.ts - prev.ts);
                        const deltaTo = (abs.to - prev.ts) / (next.ts - prev.ts);
                        prevInterpolated.data[sigConf.cid][agg] = prev.data[sigConf.cid][agg] * (1 - deltaFrom) + next.data[sigConf.cid][agg] * deltaFrom;
                        nextInterpolated.data[sigConf.cid][agg] = prev.data[sigConf.cid][agg] * (1 - deltaTo) + next.data[sigConf.cid][agg] * deltaTo;
                    }
                }

                pts = [prevInterpolated, nextInterpolated];
            }

            if (pts) {
                for (let idx = 0; idx < pts.length; idx++) {
                    const pt = pts[idx];

                    for (const sigConf of sigSetConf.signals) {
                        const yDataMin = pt.data[sigConf.cid].min;
                        if (yMin === undefined || yMin > yDataMin) {
                            yMin = yDataMin;
                        }

                        const yDataMax = pt.data[sigConf.cid].max;
                        if (yMax === undefined || yMax < yDataMax) {
                            yMax = yDataMax;
                        }
                    }
                }

                points[sigSetConf.cid] = pts;
                noData = false;
            }
        }


        let yScale;
        if (yMin !== undefined && yMax !== undefined) {
            yScale = scaleLinear()
                .domain([yMin, yMax])
                .range([this.props.height - this.props.margin.top - this.props.margin.bottom, 0]);

            const yAxis = axisLeft(yScale);

            base.yAxisSelection
                .call(yAxis);
        }
        
        
        
        const avgLineApproximators = {};
        const avgLineCircles = {};
        let selection = null;
        let mousePosition = null;

        const selectPoints = function () {
            const containerPos = mouse(base.containerNode);
            const x = containerPos[0] - self.props.margin.left;
            const y = containerPos[1] - self.props.margin.top;
            const ts = xScale.invert(x);

            base.cursorSelection
                .attr('x1', containerPos[0])
                .attr('x2', containerPos[0]);

            if (!base.cursorLineVisible) {
                base.cursorSelection.attr('visibility', 'visible');
                base.cursorLineVisible = true;
                console.log('visible');
            }

            if (noData) {
                return;
            }

            selection = {};
            let minDistance;

            // For each signal, select the point closest to the cursors
            for (const sigSetConf of config.signalSets) {
                const {main} = base.state.signalSetsData[sigSetConf.cid];
                if (main.length > 0) {
                    const bisectTs = bisector(d => d.ts).right;

                    let pointIdx = bisectTs(main, ts);

                    if (pointIdx >= main.length) {
                        pointIdx -= 1;
                    } else if (main.length > 1 && pointIdx > 0) {
                        const leftTs = main[pointIdx - 1].ts;
                        const rightTs = main[pointIdx].ts;

                        if (ts - leftTs < rightTs - ts) {
                            pointIdx -= 1;
                        }
                    }

                    const point = main[pointIdx];

                    const distance = Math.abs(point.ts - ts);
                    if (minDistance === undefined || minDistance > distance) {
                        minDistance = distance;
                    }

                    selection[sigSetConf.cid] = point;
                }
            }

            // Remove points that are not the the closest ones
            for (const sigSetConf of config.signalSets) {
                const point = selection[sigSetConf.cid];
                if (Math.abs(point.ts - ts) > minDistance) {
                    delete selection[sigSetConf.cid];
                }
            }


            let isSelection = false;

            // Draw the points including the small points on the paths that is hovered over
            for (const sigSetConf of config.signalSets) {
                const {main} = base.state.signalSetsData[sigSetConf.cid];

                const point = selection[sigSetConf.cid];

                if (point) {
                    isSelection = true;
                }

                for (const sigConf of sigSetConf.signals) {
                    if (main.length > 0) {
                        const showAllPoints = main.length <= width / 20
                            && avgLineApproximators[sigSetConf.cid][sigConf.cid].isPointContained(x, y);

                        self.avgLinePointsSelection[sigSetConf.cid][sigConf.cid].selectAll('circle').each(function (dt, idx) {
                            if (dt === point && self.avgLinePointsSelected[sigSetConf.cid][sigConf.cid][idx] !== SelectedState.SELECTED) {
                                select(this).attr('r', 6).attr('visibility', 'visible');
                                self.avgLinePointsSelected[sigSetConf.cid][sigConf.cid][idx] = SelectedState.SELECTED;
                            } else if (showAllPoints && dt !== point && self.avgLinePointsSelected[sigSetConf.cid][sigConf.cid][idx] !== SelectedState.VISIBLE) {
                                select(this).attr('r', 3).attr('visibility', 'visible');
                                self.avgLinePointsSelected[sigSetConf.cid][sigConf.cid][idx] = SelectedState.VISIBLE;
                            } else if (!showAllPoints && dt !== point && self.avgLinePointsSelected[sigSetConf.cid][sigConf.cid][idx] !== SelectedState.HIDDEN) {
                                select(this).attr('r', 3).attr('visibility', 'hidden');
                                self.avgLinePointsSelected[sigSetConf.cid][sigConf.cid][idx] = SelectedState.HIDDEN;
                            }
                        });
                    }
                }
            }


            selection = isSelection ? selection : null;

            mousePosition = {x: containerPos[0], y: containerPos[1]};

            base.setState({
                selection,
                mousePosition
            });
        };

        const deselectPoints = function () {
            if (base.cursorLineVisible) {
                base.cursorSelection.attr('visibility', 'hidden');
                base.cursorLineVisible = false;
            }

            if (noData) {
                return;
            }

            for (const sigSetConf of config.signalSets) {
                for (const sigConf of sigSetConf.signals) {
                    self.avgLinePointsSelection[sigSetConf.cid][sigConf.cid].selectAll('circle').each(function (dt, idx) {
                        if (self.avgLinePointsSelected[sigSetConf.cid][sigConf.cid][idx] !== SelectedState.HIDDEN) {
                            select(this).attr('visibility', 'hidden');
                            self.avgLinePointsSelected[sigSetConf.cid][sigConf.cid][idx] = SelectedState.HIDDEN;
                        }
                    });
                }
            }

            if (selection) {
                selection = null;
                mousePosition = null;

                base.setState({
                    selection,
                    mousePosition
                });
            }
        };

        const click = function () {
            if (self.props.onClick) {
                self.props.onClick(selection, mousePosition);
            }
        };

        base.brushSelection
            .on('mouseenter', selectPoints)
            .on('mousemove', selectPoints)
            .on('mouseleave', deselectPoints)
            .on('click', click);


        if (noData) {
            return RenderStatus.NO_DATA;
        }


        const avgLine = sigCid => line()
            .x(d => xScale(d.ts))
            .y(d => yScale(d.data[sigCid].avg))
            .curve(curveMonotoneX);

        const minMaxArea = sigCid => area()
            .x(d => xScale(d.ts))
            .y0(d => yScale(d.data[sigCid].min))
            .y1(d => yScale(d.data[sigCid].max))
            .curve(curveMonotoneX);


        for (const sigSetConf of config.signalSets) {
            avgLineCircles[sigSetConf.cid] = {};
            avgLineApproximators[sigSetConf.cid] = {};

            this.avgLinePointsSelected[sigSetConf.cid] = {};

            if (points[sigSetConf.cid]) {
                const {main} = base.state.signalSetsData[sigSetConf.cid];

                for (const sigConf of sigSetConf.signals) {

                    const avgLineColor = rgb(sigConf.color);
                    this.avgLinePathSelection[sigSetConf.cid][sigConf.cid]
                        .datum(points[sigSetConf.cid])
                        .attr('fill', 'none')
                        .attr('stroke', avgLineColor.toString())
                        .attr('stroke-linejoin', 'round')
                        .attr('stroke-linecap', 'round')
                        .attr('stroke-width', 1.5)
                        .attr('d', avgLine(sigConf.cid));

                    const minMaxAreaColor = rgb(sigConf.color);
                    minMaxAreaColor.opacity = 0.5;
                    this.areaPathSelection[sigSetConf.cid][sigConf.cid]
                        .datum(points[sigSetConf.cid])
                        .attr('fill', minMaxAreaColor.toString())
                        .attr('stroke', 'none')
                        .attr('stroke-linejoin', 'round')
                        .attr('stroke-linecap', 'round')
                        .attr('d', minMaxArea(sigConf.cid));

                    const circles = this.avgLinePointsSelection[sigSetConf.cid][sigConf.cid]
                        .selectAll('circle')
                        .data(main);

                    circles.enter().append('circle')
                        .merge(circles)
                        .attr('cx', d => xScale(d.ts))
                        .attr('cy', d => yScale(d.data[sigConf.cid].avg))
                        .attr('r', 3)
                        .attr('visibility', 'hidden')
                        .attr('fill', avgLineColor.toString());

                    this.avgLinePointsSelected[sigSetConf.cid][sigConf.cid] = Array(main.length).fill(SelectedState.HIDDEN);

                    circles.exit().remove();

                    avgLineCircles[sigSetConf.cid][sigConf.cid] = circles;

                    avgLineApproximators[sigSetConf.cid][sigConf.cid] = new DataPathApproximator(this.avgLinePathSelection[sigSetConf.cid][sigConf.cid].node(), xScale, yScale, width);
                }
            }
        }

        return RenderStatus.SUCCESS;
    }

    getGraphContent(base) {
        const config = this.props.config;

        const paths = [];
        for (const sigSetConf of config.signalSets) {
            this.areaPathSelection[sigSetConf.cid] = {};
            this.avgLinePathSelection[sigSetConf.cid] = {};
            this.avgLinePointsSelection[sigSetConf.cid] = {};

            for (const sigConf of sigSetConf.signals) {
                paths.push(
                    <g key={sigSetConf.cid + " " + sigConf.cid}>
                        <path ref={node => this.areaPathSelection[sigSetConf.cid][sigConf.cid] = select(node)}/>
                        <path ref={node => this.avgLinePathSelection[sigSetConf.cid][sigConf.cid] = select(node)}/>
                        <g ref={node => this.avgLinePointsSelection[sigSetConf.cid][sigConf.cid] = select(node)}/>
                    </g>
                );
            }
        }

        return paths;
    }

    render() {
        const props = this.props;

        const extraProps = {};

        if (this.props.tooltipContentComponent) {
            extraProps.tooltipContentComponent = tooltipContentComponent;
        } else if (this.props.contentRender) {
            extraProps.tooltipContentRender = tooltipContentRender;
        } else {
            extraProps.tooltipContentComponent = TooltipContent;
        }

        return (
            <TimeBasedChart
                config={props.config}
                height={props.height}
                margin={props.margin}
                getSignalAggs={(base, sigSetCid, sigCid) => ['min', 'max', 'avg']}
                prepareData={(base, data) => data}
                createChart={this.boundCreateChart}
                getGraphContent={this.boundGetGraphContent}
                withTooltip={props.withTooltip}
                withBrush={props.withBrush}
                contentComponent={props.contentComponent}
                contentRender={props.contentRender}
                {...extraProps}
            />
        );
    }
}
