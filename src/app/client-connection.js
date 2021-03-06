/*
 * Copyright 2017 Samsung Electronics Co., Ltd. and other contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import ParseSource from './client-parsesource';
import { JERRY_DEBUGGER_VERSION, PROTOCOL, ENGINE_MODE } from './client-debugger';
import { MARKER_TYPE } from './modules/session/marker';
import { SURFACE_CSICON, SURFACE_RUN_UPDATE_TYPE } from './surface';
import Transpiler from './transpiler';
import Util from './util';
import { SOURCE_SNYC_ACTION } from './session';
import Logger from './logger';

export default class Connection {

  /**
   * Constructor.
   *
   * @param {object} debuggerObject The DebuggerClient module object.
   * @param {object} address Connection host address and host port.
   * @param {object} surface The Surface module object.
   * @param {object} session The Session module object.
   * @param {object} settings The Settings module object.
   * @param {object} chart The MemoryChart module object.
   */
  constructor(debuggerObject, address, surface, session, settings, chart) {
    this._debuggerObj = debuggerObject;
    this._surface = surface;
    this._session = session;
    this._settings = settings;
    this._chart = chart;
    this._transpiler = new Transpiler();
    this._output = new Logger($('#output-panel'));
    this._logger = new Logger($('#console-panel'));

    this._parseObj = null;

    this._exceptionData = null;
    this._evalResult = null;
    this._outputResult = null;

    this._socket = new WebSocket(`ws://${address}/jerry-debugger`);
    this._socket.binaryType = 'arraybuffer';
    this._socket.abortConnection = this.abort;

    this._socket.onopen = onopen.bind(this);
    this._socket.onmessage = onmessage.bind(this);
    this._socket.onclose = this._socket.onerror = onclose_and_error.bind(this);

    this._logger.info(`ws://${address}/jerry-debugger`);
  }

  /**
   * Closes the socket connection.
   */
  close() {
    this._socket.close();
    this._socket = null;
    this._parseObj = null;
  }

  /**
   * Aborts the connection and close the socket.
   *
   * @param {string} message The abort message.
   */
  abort(message) {
    Util.assert(this._socket);

    this.close();

    this._logger.error(`Connection aborted: ${message}`, true);
    throw new Error(message);
  }

  /**
   * Sends a message through the socket.
   *
   * @param {uint8} message The message data.
   */
  send(message) {
    this._socket.send(message);

    if (message[0] === PROTOCOL.CLIENT.JERRY_DEBUGGER_CONTINUE ||
        message[0] === PROTOCOL.CLIENT.JERRY_DEBUGGER_STEP ||
        message[0] === PROTOCOL.CLIENT.JERRY_DEBUGGER_NEXT) {
      this._debuggerObj.setEngineMode(ENGINE_MODE.RUN);
    }
  }
}

/**
 * The socket onopen event handler.
 * This function will be called when the socket established the connection.
 */
function onopen() {
  this._logger.info('Connection created.');

  this._debuggerObj.setEngineMode(ENGINE_MODE.RUN);

  if (this._surface.getPanelProperty('chart.active')) {
    this._surface.toggleButton(true, 'chart-record-button');
  }

  if (this._surface.getPanelProperty('run.active')) {
    this._surface.updateRunPanel(SURFACE_RUN_UPDATE_TYPE.ALL, this._debuggerObj, this._session);
  }

  if (this._surface.getPanelProperty('watch.active')) {
    this._surface.updateWatchPanelButtons(this._debuggerObj);
  }

  this._surface.disableActionButtons(false);
  this._surface.toggleButton(false, 'connect-to-button');
}

/**
 * The socket onclose_and_error event handler.
 * This function will be called when the socket runs into an error.
 * This function will be called when we want to close the socket.
 */
function onclose_and_error() {
  if (this._socket) {
    this._socket = null;
  }

  this._logger.info('Connection closed.');

  this._debuggerObj.setEngineMode(ENGINE_MODE.DISCONNECTED);

  if (this._surface.getPanelProperty('chart.active')) {
    this._chart.disableChartButtons();
    if (this._chart.containsData()) {
      this._surface.toggleButton(true, 'chart-reset-button');
    }
  }

  if (this._surface.getPanelProperty('watch.active')) {
    this._surface.updateWatchPanelButtons(this._debuggerObj);
    this._session.neutralizeWatchExpressions();
  }

  if (this._settings.getValue('debugger.transpileToES5') && !this._transpiler.isEmpty()) {
    this._transpiler.clearTranspiledSources();
  }

  if (this._session.isUploadStarted()) {
    this._session.setUploadStarted(false);
  }

  // Reset the editor.
  this._session.reset();
  this._surface.reset();
  this._surface.disableActionButtons(true);
  this._surface.toggleButton(true, 'connect-to-button');
  this._surface.continueStopButtonState(SURFACE_CSICON.CONTINUE);

  if (this._session.isContextReset()) {
    this._session.setContextReset(false);

    // Try to reconnect once.
    setTimeout(() => {
      $('#connect-to-button').trigger('click');
    }, 1000);
  }
}

/**
 * The socket onmessage event handler.
 * This function will be called when the socket got a message.
 *
 * @param {event} event The socket event. This contains the incoming data.
 */
function onmessage(event) {
  const message = new Uint8Array(event.data);

  if (message.byteLength < 1) {
    this._socket.abortConnection('message too short.');
  }

  if (this._debuggerObj.getCPointerSize() === 0) {
    if (message[0] !== PROTOCOL.SERVER.JERRY_DEBUGGER_CONFIGURATION ||
        message.byteLength !== 5) {
      this._socket.abortConnection('the first message must be configuration.');
    }

    this._debuggerObj.setMaxMessageSize(message[1]);
    this._debuggerObj.setCPointerSize(message[2]);
    this._debuggerObj.setLittleEndian((message[3] != 0));
    this._debuggerObj.setProtocolVersion(message[4]);

    if (this._debuggerObj.getCPointerSize() !== 2 && this._debuggerObj.getCPointerSize() !== 4) {
      this._socket.abortConnection('compressed pointer must be 2 or 4 bytes long.');
    }

    if (this._debuggerObj.getProtocolVersion() !== JERRY_DEBUGGER_VERSION) {
      this._socket.abortConnection('Incorrect debugger version from target.');
    }

    return;
  }

  if (this._parseObj) {
    this._parseObj.receive(message);
    if (!this._parseObj.isAlive()) {
      this._parseObj = null;
    }
    return;
  }

  switch (message[0]) {
    case PROTOCOL.SERVER.JERRY_DEBUGGER_PARSE_ERROR:
    case PROTOCOL.SERVER.JERRY_DEBUGGER_BYTE_CODE_CP:
    case PROTOCOL.SERVER.JERRY_DEBUGGER_PARSE_FUNCTION:
    case PROTOCOL.SERVER.JERRY_DEBUGGER_BREAKPOINT_LIST:
    case PROTOCOL.SERVER.JERRY_DEBUGGER_SOURCE_CODE:
    case PROTOCOL.SERVER.JERRY_DEBUGGER_SOURCE_CODE_END:
    case PROTOCOL.SERVER.JERRY_DEBUGGER_SOURCE_CODE_NAME:
    case PROTOCOL.SERVER.JERRY_DEBUGGER_SOURCE_CODE_NAME_END:
    case PROTOCOL.SERVER.JERRY_DEBUGGER_FUNCTION_NAME:
    case PROTOCOL.SERVER.JERRY_DEBUGGER_FUNCTION_NAME_END: {
      this._parseObj = new ParseSource(this._debuggerObj);
      this._parseObj.receive(message);
      if (!this._parseObj.isAlive()) {
        this._parseObj = null;
      }
      return;
    }

    case PROTOCOL.SERVER.JERRY_DEBUGGER_WAITING_AFTER_PARSE: {
      this._debuggerObj.encodeMessage('B', [PROTOCOL.CLIENT.JERRY_DEBUGGER_PARSER_RESUME]);
      return;
    }

    case PROTOCOL.SERVER.JERRY_DEBUGGER_RELEASE_BYTE_CODE_CP: {
      this._debuggerObj.releaseFunction(message);
      return;
    }

    case PROTOCOL.SERVER.JERRY_DEBUGGER_MEMSTATS_RECEIVE: {
      const messagedata = this._debuggerObj.decodeMessage('IIIII', message, 1);

      // Continue if we have any data.
      if (messagedata[0] !== 0) {
        if (this._chart.isRecordStarted()) {
          this._chart.startRecord(false);
          this._chart.setChartActive(true);

          this._surface.toggleButton(false, 'chart-reset-button');
          this._surface.toggleButton(true, 'chart-stop-button');
          this._surface.toggleButton(false, 'chart-record-button');
          $('#chart-record-button').css('background-color', '#16e016');
        }

        if (this._session.chartInfo && this._chart.isChartActive()) {
          const breakpointInfo = this._session.chartInfo.split(':')[1].split(' ')[0];
          let breakpointLineToChart = `ln: ${breakpointInfo}`;

          if (this._debuggerObj.getEngineMode() === ENGINE_MODE.BREAKPOINT) {
            breakpointLineToChart = `#${breakpointInfo}: ${new Date().toISOString().slice(14, 21)}`;
          }

          this._chart.addNewDataPoints(messagedata, breakpointLineToChart);
        }
      } else {
        // Notify the user about that, propbably the jerry was built without the memory statistic swicth.
        this._logger.error(
          'There are no memory statistics available. ' +
          'If you want to use the memory usage panel check the engine build command first.',
          true
        );
      }

      return;
    }

    case PROTOCOL.SERVER.JERRY_DEBUGGER_BREAKPOINT_HIT:
    case PROTOCOL.SERVER.JERRY_DEBUGGER_EXCEPTION_HIT: {
      this._debuggerObj.setEngineMode(ENGINE_MODE.BREAKPOINT);

      const breakpointData = this._debuggerObj.decodeMessage('CI', message, 1);
      const breakpointRef = this._debuggerObj.getBreakpoint(breakpointData);
      const breakpoint = breakpointRef.breakpoint;
      let sourceName = breakpoint.func.sourceName;
      const source = this._debuggerObj.getSources()[sourceName];
      let breakpointInfo = '';

      this._debuggerObj.breakpoints.lastHit = breakpoint;

      if (breakpoint.offset.index >= 0) {
        breakpointInfo = ` breakpoint:${breakpoint.offset.index} `;
      }

      this._session.lastBreakpoint = breakpoint;
      this._surface.continueStopButtonState(SURFACE_CSICON.CONTINUE);
      this._surface.disableActionButtons(false);

      // Source load and reload from Jerry.
      if (sourceName !== '') {
        if (!this._session.fileNameCheck(sourceName, true)) {
          this._session.storeJerrySource(sourceName, source);
          this._session.setJerrySourceAction(SOURCE_SNYC_ACTION.LOAD);

          if (this._session.isAutoSourceSync()) {
            this._session.syncSourceFromJerry();
            this._session.setAutoSourceSync(false);
          } else {
            this._logger.warning(`The file "${sourceName}" is missing.`, true);
            this._surface.toggleButton(true, 'jerry-sync-source-button');
          }
        } else {
          // Disable the auto source sync option in case of valid source.
          this._session.setAutoSourceSync(false);

          // Do not check the code match if the transpile is enabled.
          if (!this._settings.getValue('debugger.transpileToES5') && this._transpiler.isEmpty()) {
            if (!this._session.fileContentCheck(sourceName, source)) {
              this._session.setJerrySourceAction(SOURCE_SNYC_ACTION.RELOAD);
              this._logger.warning(`The "${sourceName}" source does not match with the source on the device!`, true);
              this._surface.toggleButton(true, 'jerry-sync-source-button');
            }
          }
        }
      } else {
        sourceName = this._session.handleUnknownFile(
          Array.isArray(breakpoint.func.source) ? breakpoint.func.source.join('\n') : breakpoint.func.source
        );
      }

      // Switch to the the right session.
      const fid = this._session.getFileIdByName(sourceName);
      if (fid !== undefined && fid !== this._session.getActiveID()) {
        // Change the model in the editor.
        this._session.switchFile(fid);
      }

      // Get the right line, which is depends on that if we use transpiled code or not.
      let hlLine = breakpoint.line;

      if (this._settings.getValue('debugger.transpileToES5') && !this._transpiler.isEmpty()) {
        hlLine = this._transpiler.getOriginalPositionFor(sourceName.split('/').pop(), breakpoint.line, 0).line - 1;
      }

      // After we switched to the correct file/session show the exception hint (if exists).
      if (message[0] === PROTOCOL.SERVER.JERRY_DEBUGGER_EXCEPTION_HIT) {
        this._session.highlightLine(MARKER_TYPE.EXCEPTION, hlLine);
        this._logger.error('Exception throw detected!');

        if (this._exceptionData) {
          this._logger.error('Exception hint: ' + this._debuggerObj.cesu8ToString(this._exceptionData), true);
          this._exceptionData = null;
        }
      } else {
        // Highlight the execute line in the correct session.
        if (fid !== undefined && fid === this._session.getActiveID()) {
          this._session.highlightLine(MARKER_TYPE.EXECUTE, hlLine);
          this._session.markBreakpointLines(this._debuggerObj, this._settings, this._transpiler);
        }
      }

      // Show the backtrace on the panel.
      if (this._surface.getPanelProperty('backtrace.active')) {
        this._debuggerObj.getBacktrace(this._debuggerObj);
      }

      // Updates the watched expression list if the watch panel is active.
      if (this._surface.getPanelProperty('watch.active')) {
        this._session.updateWatchExpressions(this._debuggerObj);
      }

      // Add breakpoint information to chart.
      if (this._surface.getPanelProperty('chart.active')) {
        for (const i in this._debuggerObj.breakpoints.activeBreakpoints) {
          if (this._debuggerObj.breakpoints.activeBreakpoints[i].line ===
              this._debuggerObj.breakpointToString(breakpoint).split(':')[1].split(' ')[0]) {
            this._surface.stopCommand();
            return;
          }
        }

        this._debuggerObj.encodeMessage('B', [PROTOCOL.CLIENT.JERRY_DEBUGGER_MEMSTATS]);
        this._session.chartInfo = this._debuggerObj.breakpointToString(breakpoint);
      }

      this._logger.info(
        `Stopped ${(breakpoint.at ? 'at ' : 'around ')}` +
        breakpointInfo +
        this._debuggerObj.breakpointToString(breakpoint)
      );

      return;
    }

    case PROTOCOL.SERVER.JERRY_DEBUGGER_EXCEPTION_STR:
    case PROTOCOL.SERVER.JERRY_DEBUGGER_EXCEPTION_STR_END: {
      this._exceptionData = this._debuggerObj.concatUint8Arrays(this._exceptionData, message);
      return;
    }

    case PROTOCOL.SERVER.JERRY_DEBUGGER_BACKTRACE:
    case PROTOCOL.SERVER.JERRY_DEBUGGER_BACKTRACE_END: {
      Util.clearElement($('#backtrace-table-body'));

      for (let i = 1; i < message.byteLength; i += this._debuggerObj.getCPointerSize() + 4) {
        const breakpointData = this._debuggerObj.decodeMessage('CI', message, i);

        this._surface.updateBacktracePanel(
          this._debuggerObj.getBacktraceFrame(),
          this._debuggerObj.getBreakpoint(breakpointData).breakpoint,
          this._settings,
          this._transpiler
        );

        this._debuggerObj.setBacktraceFrame(this._debuggerObj.getBacktraceFrame() + 1);
      }

      if (message[0] === PROTOCOL.SERVER.JERRY_DEBUGGER_BACKTRACE_END) {
        this._debuggerObj.setBacktraceFrame(0);
      }

      return;
    }

    case PROTOCOL.SERVER.JERRY_DEBUGGER_EVAL_RESULT:
    case PROTOCOL.SERVER.JERRY_DEBUGGER_EVAL_RESULT_END: {
      this._evalResult = this._debuggerObj.concatUint8Arrays(this._evalResult, message);

      const subType = this._evalResult[this._evalResult.length - 1];

      this._evalResult = this._evalResult.slice(0, -1);

      if (subType === PROTOCOL.SERVER.JERRY_DEBUGGER_EVAL_OK) {
        if (this._surface.getPanelProperty('watch.active') && this._session.isWatchInProgress()) {
          this._session.stopWatchProgress();
          this._session.addWatchExpressionValue(
            this._debuggerObj,
            this._session.getWatchCurrentExpr(),
            this._debuggerObj.cesu8ToString(this._evalResult)
          );
        } else {
          this._logger.info(this._debuggerObj.cesu8ToString(this._evalResult));
        }

        this._evalResult = null;

        return;
      }

      if (subType === PROTOCOL.SERVER.JERRY_DEBUGGER_EVAL_ERROR) {
        if (this._surface.getPanelProperty('watch.active') && this._session.isWatchInProgress()) {
          this._session.stopWatchProgress();
          this._session.addWatchExpressionValue(
            this._debuggerObj,
            this._session.getWatchCurrentExpr(),
            ''
          );
        } else {
          this._logger.info('Uncaught exception: ' + this._debuggerObj.cesu8ToString(this._evalResult));
        }

        this._evalResult = null;

        return;
      }

      return;
    }

    case PROTOCOL.SERVER.JERRY_DEBUGGER_OUTPUT_RESULT:
    case PROTOCOL.SERVER.JERRY_DEBUGGER_OUTPUT_RESULT_END: {
      this._outputResult = this._debuggerObj.concatUint8Arrays(this._outputResult, message);

      if (message[0] === PROTOCOL.SERVER.JERRY_DEBUGGER_OUTPUT_RESULT_END) {
        const subType = this._outputResult[this._outputResult.length - 1];

        this._outputResult = this._outputResult.slice(0, -1);

        switch (subType) {
          case PROTOCOL.SERVER.JERRY_DEBUGGER_OUTPUT_OK:
            this._output.info(this._debuggerObj.cesu8ToString(this._outputResult));
            break;
          case PROTOCOL.SERVER.JERRY_DEBUGGER_OUTPUT_DEBUG:
            this._output.debug(this._debuggerObj.cesu8ToString(this._outputResult));
            break;
          case PROTOCOL.SERVER.JERRY_DEBUGGER_OUTPUT_WARNING:
            this._output.warning(this._debuggerObj.cesu8ToString(this._outputResult));
            break;
          case PROTOCOL.SERVER.JERRY_DEBUGGER_OUTPUT_ERROR:
            this._output.error(this._debuggerObj.cesu8ToString(this._outputResult));
            break;
          case PROTOCOL.SERVER.JERRY_DEBUGGER_OUTPUT_TRACE:
            this._output.info(`TRACE: ${this._debuggerObj.cesu8ToString(this._outputResult)}`);
            break;
        }

        this._outputResult = null;
      }

      return;
    }

    case PROTOCOL.SERVER.JERRY_DEBUGGER_WAIT_FOR_SOURCE: {
      this._debuggerObj.setEngineMode(ENGINE_MODE.CLIENT_SOURCE);

      this._surface.disableActionButtons(true);
      this._session.allowUploadAndRun(true);

      if (this._surface.getPanelProperty('run.active')) {
        this._surface.updateRunPanel(SURFACE_RUN_UPDATE_TYPE.BUTTON, this._debuggerObj, this._session);
      }

      this._debuggerObj.sendClientSource();
      return;
    }

    default: {
      this._socket.abortConnection('unexpected message.');
      return;
    }
  }
}
