var SafariExtensionCommunicator = (function (msgHandler) {
    'use strict'
    var publicAPI = {}

    // Connect the provided message handler to the received messages.
    safari.self.addEventListener("message", msgHandler)

    var sendMessage = function(msgName, userInfo) {
        safari.extension.dispatchMessage(msgName, userInfo)
    }

    publicAPI.requestSettingsUpdate = function() {
        sendMessage("updateSettings")
    }
    publicAPI.requestTabForward = function() {
        sendMessage("tabForward")
    }
    publicAPI.requestTabBackward = function() {
        sendMessage("tabBackward")
    }
    publicAPI.requestCloseTab = function () {
        sendMessage("closeTab")
    }

    publicAPI.requestTabList = function () {
        sendMessage("requestTabList")
    }
    publicAPI.requestActivateTab = function (id) {
        sendMessage("activateTab", { id: id })
    }
    publicAPI.reportActive = function () {
        sendMessage("reportActive")
    }

    // Return only the public methods.
    return publicAPI;
});
