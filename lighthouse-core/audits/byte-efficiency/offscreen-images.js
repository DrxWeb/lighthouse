/**
 * @license Copyright 2017 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
/**
 * @fileoverview Checks to see if images are displayed only outside of the viewport.
 *     Images requested after TTI are not flagged as violations.
 */
'use strict';

const ByteEfficiencyAudit = require('./byte-efficiency-audit.js');
const Sentry = require('../../lib/sentry.js');
const URL = require('../../lib/url-shim.js');
const i18n = require('../../lib/i18n/i18n.js');
const Interactive = require('../../computed/metrics/interactive.js');
const TraceOfTab = require('../../computed/trace-of-tab.js');

const UIStrings = {
  /** Imperative title of a Lighthouse audit that tells the user to defer loading offscreen images. Offscreen images are images located outside of the visible browser viewport. As they are unseen by the user and slow down page load, they should be loaded later, closer to when the user is going to see them. This is displayed in a list of audit titles that Lighthouse generates. */
  title: 'Defer offscreen images',
  /** Description of a Lighthouse audit that tells the user *why* they should defer loading offscreen images. Offscreen images are images located outside of the visible browser viewport. As they are unseen by the user and slow down page load, they should be loaded later, closer to when the user is going to see them. This is displayed after a user expands the section to see more. No character length limits. 'Learn More' becomes link text to additional documentation. */
  description:
    'Consider lazy-loading offscreen and hidden images after all critical resources have ' +
    'finished loading to lower time to interactive. ' +
    '[Learn more](https://web.dev/offscreen-images).',
};

const str_ = i18n.createMessageInstanceIdFn(__filename, UIStrings);

const ALLOWABLE_OFFSCREEN_X = 100;
const ALLOWABLE_OFFSCREEN_Y = 200;

const IGNORE_THRESHOLD_IN_BYTES = 2048;
const IGNORE_THRESHOLD_IN_PERCENT = 75;
const IGNORE_THRESHOLD_IN_MS = 50;

/** @typedef {{url: string, requestStartTime: number, totalBytes: number, wastedBytes: number, wastedPercent: number}} WasteResult */

class OffscreenImages extends ByteEfficiencyAudit {
  /**
   * @return {LH.Audit.Meta}
   */
  static get meta() {
    return {
      id: 'offscreen-images',
      title: str_(UIStrings.title),
      description: str_(UIStrings.description),
      scoreDisplayMode: ByteEfficiencyAudit.SCORING_MODES.NUMERIC,
      requiredArtifacts: ['ImageElements', 'ViewportDimensions', 'devtoolsLogs', 'traces'],
    };
  }

  /**
   * @param {{top: number, bottom: number, left: number, right: number}} imageRect
   * @param {{innerWidth: number, innerHeight: number}} viewportDimensions
   * @return {number}
   */
  static computeVisiblePixels(imageRect, viewportDimensions) {
    const innerWidth = viewportDimensions.innerWidth;
    const innerHeight = viewportDimensions.innerHeight;

    const top = Math.max(imageRect.top, -1 * ALLOWABLE_OFFSCREEN_Y);
    const right = Math.min(imageRect.right, innerWidth + ALLOWABLE_OFFSCREEN_X);
    const bottom = Math.min(imageRect.bottom, innerHeight + ALLOWABLE_OFFSCREEN_Y);
    const left = Math.max(imageRect.left, -1 * ALLOWABLE_OFFSCREEN_X);

    return Math.max(right - left, 0) * Math.max(bottom - top, 0);
  }

  /**
   * @param {LH.Artifacts.ImageElement} image
   * @param {{innerWidth: number, innerHeight: number}} viewportDimensions
   * @param {Array<LH.Artifacts.NetworkRequest>} networkRecords
   * @return {null|Error|WasteResult}
   */
  static computeWaste(image, viewportDimensions, networkRecords) {
    const networkRecord = networkRecords.find(record => record.url === image.src);
    if (!image.resourceSize || !networkRecord) {
      return null;
    }

    const url = URL.elideDataURI(image.src);
    const totalPixels = image.displayedWidth * image.displayedHeight;
    const visiblePixels = this.computeVisiblePixels(image.clientRect, viewportDimensions);
    // Treat images with 0 area as if they're offscreen. See https://github.com/GoogleChrome/lighthouse/issues/1914
    const wastedRatio = totalPixels === 0 ? 1 : 1 - visiblePixels / totalPixels;
    const totalBytes = image.resourceSize;
    const wastedBytes = Math.round(totalBytes * wastedRatio);

    if (!Number.isFinite(wastedRatio)) {
      return new Error(`Invalid image sizing information ${url}`);
    }

    return {
      url,
      requestStartTime: networkRecord.startTime,
      totalBytes,
      wastedBytes,
      wastedPercent: 100 * wastedRatio,
    };
  }

  /**
   * Filters out image requests that were requested after the last long task based on lantern timings.
   *
   * @param {WasteResult[]} images
   * @param {LH.Artifacts.LanternMetric} lanternMetricData
   */
  static filterLanternResults(images, lanternMetricData) {
    const nodeTimings = lanternMetricData.pessimisticEstimate.nodeTimings;

    // Find the last long task start time
    let lastLongTaskStartTime = 0;
    // Find the start time of all requests
    /** @type {Map<string, number>} */
    const startTimesByURL = new Map();
    for (const [node, timing] of nodeTimings) {
      if (node.type === 'cpu' && timing.duration >= 50) {
        lastLongTaskStartTime = Math.max(lastLongTaskStartTime, timing.startTime);
      } else if (node.type === 'network') {
        const networkNode = /** @type {LH.Gatherer.Simulation.GraphNetworkNode} */ (node);
        startTimesByURL.set(networkNode.record.url, timing.startTime);
      }
    }

    return images.filter(image => {
      // Filter out images that had little waste
      if (image.wastedBytes < IGNORE_THRESHOLD_IN_BYTES) return false;
      if (image.wastedPercent < IGNORE_THRESHOLD_IN_PERCENT) return false;
      // Filter out images that started after the last long task
      const imageRequestStartTime = startTimesByURL.get(image.url) || 0;
      return imageRequestStartTime < lastLongTaskStartTime - IGNORE_THRESHOLD_IN_MS;
    });
  }

  /**
   * Filters out image requests that were requested after TTI.
   *
   * @param {WasteResult[]} images
   * @param {number} interactiveTimestamp
   */
  static filterObservedResults(images, interactiveTimestamp) {
    return images.filter(image => {
      if (image.wastedBytes < IGNORE_THRESHOLD_IN_BYTES) return false;
      if (image.wastedPercent < IGNORE_THRESHOLD_IN_PERCENT) return false;
      return image.requestStartTime < interactiveTimestamp / 1e6 - IGNORE_THRESHOLD_IN_MS / 1000;
    });
  }

  /**
   * The default byte efficiency audit will report max(TTI, load), since lazy-loading offscreen
   * images won't reduce the overall time and the wasted bytes are really only "wasted" for TTI,
   * override the function to just look at TTI savings.
   *
   * @param {Array<LH.Audit.ByteEfficiencyItem>} results
   * @param {LH.Gatherer.Simulation.GraphNode} graph
   * @param {LH.Gatherer.Simulation.Simulator} simulator
   * @return {number}
   */
  static computeWasteWithTTIGraph(results, graph, simulator) {
    return super.computeWasteWithTTIGraph(results, graph, simulator,
      {includeLoad: false});
  }

  /**
   * @param {LH.Artifacts} artifacts
   * @param {Array<LH.Artifacts.NetworkRequest>} networkRecords
   * @param {LH.Audit.Context} context
   * @return {Promise<ByteEfficiencyAudit.ByteEfficiencyProduct>}
   */
  static async audit_(artifacts, networkRecords, context) {
    const images = artifacts.ImageElements;
    const viewportDimensions = artifacts.ViewportDimensions;
    const trace = artifacts.traces[ByteEfficiencyAudit.DEFAULT_PASS];
    const devtoolsLog = artifacts.devtoolsLogs[ByteEfficiencyAudit.DEFAULT_PASS];

    /** @type {string[]} */
    const warnings = [];
    const resultsMap = images.reduce((results, image) => {
      const processed = OffscreenImages.computeWaste(image, viewportDimensions, networkRecords);
      if (processed === null) {
        return results;
      }

      if (processed instanceof Error) {
        warnings.push(processed.message);
        Sentry.captureException(processed, {tags: {audit: this.meta.id}, level: 'warning'});
        return results;
      }

      // If an image was used more than once, warn only about its least wasteful usage
      const existing = results.get(processed.url);
      if (!existing || existing.wastedBytes > processed.wastedBytes) {
        results.set(processed.url, processed);
      }

      return results;
    }, /** @type {Map<string, WasteResult>} */ (new Map()));

    const settings = context.settings;

    let items;
    const unfilteredResults = Array.from(resultsMap.values());
    // get the interactive time or fallback to getting the end of trace time
    try {
      const interactive = await Interactive.request({trace, devtoolsLog, settings}, context);

      // use interactive to generate items
      const lanternInteractive = /** @type {LH.Artifacts.LanternMetric} */ (interactive);
      // Filter out images that were loaded after all CPU activity
      items = context.settings.throttlingMethod === 'simulate' ?
        OffscreenImages.filterLanternResults(unfilteredResults, lanternInteractive) :
        // @ts-ignore - .timestamp will exist if throttlingMethod isn't lantern
        OffscreenImages.filterObservedResults(unfilteredResults, interactive.timestamp);
    } catch (err) {
      // if the error is during a Lantern run, end of trace may also be inaccurate, so rethrow
      if (context.settings.throttlingMethod === 'simulate') {
        throw err;
      }
      // use end of trace as a substitute for finding interactive time
      items = OffscreenImages.filterObservedResults(unfilteredResults,
        await TraceOfTab.request(trace, context).then(tot => tot.timestamps.traceEnd));
    }

    /** @type {LH.Audit.Details.Opportunity['headings']} */
    const headings = [
      {key: 'url', valueType: 'thumbnail', label: ''},
      {key: 'url', valueType: 'url', label: str_(i18n.UIStrings.columnURL)},
      {key: 'totalBytes', valueType: 'bytes', label: str_(i18n.UIStrings.columnSize)},
      {key: 'wastedBytes', valueType: 'bytes', label: str_(i18n.UIStrings.columnWastedBytes)},
    ];

    return {
      warnings,
      items,
      headings,
    };
  }
}

module.exports = OffscreenImages;
module.exports.UIStrings = UIStrings;