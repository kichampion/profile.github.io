
(function () {
  console.log("[ColorboxAI.Standalone] Standalone browser runtime initialized.");
  try {
    var testKey = "__colorbox_storage_test__";
    window.localStorage.setItem(testKey, "test");
    window.localStorage.removeItem(testKey);
    console.log("[ColorboxAI.StorageCheck] Standalone LocalStorage is available.");
  } catch (e) {
    console.warn("[ColorboxAI.StorageCheck] Standalone LocalStorage is NOT available:", e.message || e);
  }
  try {
    var testSessionKey = "__colorbox_session_storage_test__";
    window.sessionStorage.setItem(testSessionKey, "test");
    window.sessionStorage.removeItem(testSessionKey);
    console.log("[ColorboxAI.StorageCheck] Standalone SessionStorage is available.");
  } catch (e) {
    console.warn("[ColorboxAI.StorageCheck] Standalone SessionStorage is NOT available:", e.message || e);
  }

  var globalState = {
    pageTrackCode: "PHBS7947",
    pi: "",
    wxShareTitle: document.title || ""
  };

  function createColorboxBbsApi() {
    var ENTERPRISE_HOST_MAP = {
      dev: "https://enterprise-stg.hupu.com",
      sit: "https://enterprise.hupu.com",
      stg: "https://enterprise-stg.hupu.com",
      prod: "https://enterprise.hupu.com"
    };
    var BBS_HOST_MAP = {
      dev: "https://bbs-pre.mobileapi.hupu.com",
      sit: "https://bbs-sit.mobileapi.hupu.com",
      stg: "https://bbs-pre.mobileapi.hupu.com",
      prod: "https://bbs.mobileapi.hupu.com"
    };

    function getQuery(name) {
      var params = new URLSearchParams(window.location.search || "");
      return params.get(name) || "";
    }

    function getRuntimeEnv() {
      var queryEnv = getQuery("env");
      if (queryEnv === "sit" || queryEnv === "test") return "sit";
      if (queryEnv === "stg" || queryEnv === "pre") return "stg";
      if (queryEnv === "dev") return "dev";
      var host = window.location.host || "";
      if (host.indexOf("dev") >= 0 || host.indexOf("local") >= 0) return "dev";
      if (host.indexOf("-sit") >= 0) return "sit";
      if (host.indexOf("-stg") >= 0) return "stg";
      return "prod";
    }

    function getNativeInfo() {
      return window.userInfo || (window.HupuBridge && window.HupuBridge.nainfo) || {};
    }

    function getAuthToken() {
      var info = getNativeInfo();
      return info.authToken || info.token || "";
    }

    function getAppVersion() {
      var info = getNativeInfo();
      return info.version || "8.0.0";
    }

    function requestJson(url) {
      var headers = { "Content-Type": "application/json;charset=UTF-8" };
      var token = getAuthToken();
      if (token) headers["X-Hupu-Token"] = token;
      return fetch(url, {
        credentials: "include",
        headers: headers
      }).then(function (response) {
        if (!response.ok) {
          throw new Error("BBS request failed: " + response.status);
        }
        return response.json();
      });
    }

    function cleanParams(params) {
      var next = new URLSearchParams();
      Object.keys(params || {}).forEach(function (key) {
        var value = params[key];
        if (value !== undefined && value !== null && value !== "") {
          next.set(key, String(value));
        }
      });
      return next;
    }

    function enterpriseHost() {
      return ENTERPRISE_HOST_MAP[getRuntimeEnv()] || ENTERPRISE_HOST_MAP.prod;
    }

    function bbsHost() {
      return BBS_HOST_MAP[getRuntimeEnv()] || BBS_HOST_MAP.prod;
    }

    function normalizeThreadListData(data) {
      if (Array.isArray(data)) return data;
      if (data && Array.isArray(data.list)) return data.list;
      if (data && typeof data === "object") {
        return Object.keys(data).map(function (key) { return data[key]; });
      }
      return [];
    }

    function buildPostSchema(params) {
      params = params || {};
      var tagId = params.tagId || params.postTopicId || "";
      var topicId = params.topicId || params.postZoneId || "";
      var topicName = params.topicName || "";
      var tagName = params.tagName || "";
      var title = params.title || "";
      var content = params.content || "";
      var imageUrl = params.imageUrl || "";
      var imageList = imageUrl ? [{ key: "ColorboxAI", remoteUrl: imageUrl }] : [];
      var initialValue = {
        syncPost: true,
        appJsonV3: {
          activeTab: "thread",
          data: {
            title: title,
            imageList: imageList,
            content: content
          }
        }
      };
      return "huputiyu://bbs/postImg?tagId=" + encodeURIComponent(tagId) +
        "&topicId=" + encodeURIComponent(topicId) +
        "&topicName=" + encodeURIComponent(topicName) +
        "&tagName=" + encodeURIComponent(tagName) +
        "&initialValue=" + encodeURIComponent(JSON.stringify(initialValue));
    }

    return {
      getPostDetail: function (params) {
        var tid = typeof params === "string" ? params : params && params.tid;
        if (!tid) return Promise.reject(new Error("ColorboxAI.bbs.getPostDetail requires tid"));
        var query = cleanParams({ tids: tid });
        return requestJson(enterpriseHost() + "/api/activity/threadList?" + query.toString())
          .then(function (res) {
            var list = normalizeThreadListData(res && res.data);
            return { raw: res, data: list[0] || null };
          });
      },
      getPostReplyList: function (params) {
        params = params || {};
        if (!params.tid) return Promise.reject(new Error("ColorboxAI.bbs.getPostReplyList requires tid"));
        if (!params.fid) return Promise.reject(new Error("ColorboxAI.bbs.getPostReplyList requires fid"));
        var version = params.version || getAppVersion();
        var query = cleanParams({
          tid: params.tid,
          fid: params.fid,
          page: params.page || 1,
          sort: params.sort == null ? 0 : params.sort,
          order: params.order || "asc",
          postAuthorPuid: params.postAuthorPuid
        });
        return requestJson(bbsHost() + "/1/" + encodeURIComponent(version) + "/threads/getsThreadPostList?" + query.toString());
      },
      getTopicThreads: function (params) {
        params = params || {};
        var tagId = params.tagId || params.topicId;
        if (!tagId) return Promise.reject(new Error("ColorboxAI.bbs.getTopicThreads requires tagId"));
        var query = cleanParams({
          tagId: tagId,
          tabType: params.tabType || "0",
          page: params.page || 1,
          lastCursor: params.lastCursor || ""
        });
        return requestJson(enterpriseHost() + "/api/activity/tagThreadList?" + query.toString());
      },
      buildPostSchema: buildPostSchema,
      openPostEditor: function (params) {
        console.log("[ColorboxAI.BBS] openPostEditor called. Params:", JSON.stringify(params));
        var schema = buildPostSchema(params || {});
        console.log("[ColorboxAI.BBS] Generated post schema:", schema);
        if (!params || params.navigate !== false) {
          if (typeof window.ColorboxAI !== "undefined" && typeof window.ColorboxAI.navigateTo === "function") {
            console.log("[ColorboxAI.BBS] window.ColorboxAI.navigateTo is available. Delegating schema jump.");
            window.ColorboxAI.navigateTo(schema);
          } else {
            console.log("[ColorboxAI.BBS] window.ColorboxAI.navigateTo is not available. Falling back to window.location.href.");
            window.location.href = schema;
          }
        } else {
          console.log("[ColorboxAI.BBS] navigate is set to false. Skipping redirect.");
        }
        return schema;
      }
    };
  }


  function createColorboxScoreApi() {
    var GAMES_HOST_MAP = {
      dev: "https://games-pre.mobileapi.hupu.com",
      sit: "https://games-pre.mobileapi.hupu.com",
      stg: "https://games-pre.mobileapi.hupu.com",
      prod: "https://games.mobileapi.hupu.com"
    };

    function getQuery(name) {
      var params = new URLSearchParams(window.location.search || "");
      return params.get(name) || "";
    }

    function getRuntimeEnv() {
      var queryEnv = getQuery("env");
      if (queryEnv === "sit" || queryEnv === "test") return "sit";
      if (queryEnv === "stg" || queryEnv === "pre") return "stg";
      if (queryEnv === "dev") return "dev";
      var host = window.location.host || "";
      if (host.indexOf("dev") >= 0 || host.indexOf("local") >= 0) return "dev";
      if (host.indexOf("-sit") >= 0) return "sit";
      if (host.indexOf("-stg") >= 0) return "stg";
      return "prod";
    }

    function getNativeInfo() {
      return window.userInfo || (window.HupuBridge && window.HupuBridge.nainfo) || {};
    }

    function getAuthToken() {
      var info = getNativeInfo();
      return info.authToken || info.token || "";
    }

    function getAppVersion() {
      var info = getNativeInfo();
      return info.version || "8.0.99";
    }

    function requestJson(url, options) {
      options = options || {};
      var headers = Object.assign({
        "Content-Type": "application/json;charset=UTF-8"
      }, options.headers || {});
      
      var token = getAuthToken();
      if (token) headers["X-Hupu-Token"] = token;
      
      var fetchOptions = {
        method: options.method || "GET",
        credentials: "include",
        headers: headers
      };
      if (options.body) {
        fetchOptions.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
      }

      return fetch(url, fetchOptions).then(function (response) {
        if (!response.ok) {
          throw new Error("Score request failed: " + response.status);
        }
        return response.json();
      });
    }

    function cleanParams(params) {
      var next = new URLSearchParams();
      Object.keys(params || {}).forEach(function (key) {
        var value = params[key];
        if (value !== undefined && value !== null && value !== "") {
          next.set(key, String(value));
        }
      });
      return next;
    }

    function gamesHost() {
      var env = getRuntimeEnv();
      var version = getAppVersion();
      var base = GAMES_HOST_MAP[env] || GAMES_HOST_MAP.prod;
      return base + "/1/" + version;
    }

    return {
      getScore: function (params) {
        params = params || {};
        if (!params.outBizType || !params.outBizNo) {
          return Promise.reject(new Error("ColorboxAI.score.getScore requires outBizType and outBizNo"));
        }
        var query = cleanParams({
          outBizType: params.outBizType,
          outBizNo: params.outBizNo
        });
        return requestJson(gamesHost() + "/bplcommentapi/bpl/score_tree/getSelfByBizKey?" + query.toString());
      },
      addScore: function (params) {
        params = params || {};
        if (!params.outBizType || !params.outBizNo) {
          return Promise.reject(new Error("ColorboxAI.score.addScore requires outBizType and outBizNo"));
        }
        if (params.score == null) {
          return Promise.reject(new Error("ColorboxAI.score.addScore requires score"));
        }
        var payload = {
          outBizKey: {
            outBizType: params.outBizType,
            outBizNo: params.outBizNo
          },
          score: Number(params.score),
          source: params.source || ""
        };
        return requestJson(gamesHost() + "/bplcommentapi/bpl/score/save", {
          method: "POST",
          body: payload
        });
      }
    };
  }
  

  function createColorboxOssApi() {
    var pendingCallbacks = {};

    window.addEventListener("message", function (event) {
      var data = event && event.data;
      if (!data || data.protocol !== "colorbox-ai-bridge" || data.direction !== "host-to-frame") return;
      if (data.type === "oss.upload.callback") {
        console.log("[ColorboxAI.OSS.Iframe] Received callback message from host shell:", data);
        var payload = data.payload || {};
        var callbackId = payload.callbackId;
        var callback = pendingCallbacks[callbackId];
        if (!callback) {
          console.warn("[ColorboxAI.OSS.Iframe] No pending callback found for callbackId:", callbackId);
          return;
        }

        delete pendingCallbacks[callbackId];
        if (payload.error) {
          console.error("[ColorboxAI.OSS.Iframe] Upload callback returned error for callbackId:", callbackId, payload.error);
          callback.reject(new Error(payload.error));
        } else {
          console.log("[ColorboxAI.OSS.Iframe] Upload callback succeeded for callbackId:", callbackId, "downloadUrl:", payload.downloadUrl);
          callback.resolve({
            downloadUrl: payload.downloadUrl,
            name: payload.name
          });
        }
      }
    });

    function createCallbackId() {
      return "oss_up_" + Date.now() + "_" + Math.floor(Math.random() * 1000000);
    }

    return {
      uploadFile: function (params) {
        params = params || {};
        var file = params.file;
        var filename = params.filename || (file && file.name) || "";
        var fileSize = file ? file.size : 0;
        var fileType = file ? file.type : "";

        console.log("[ColorboxAI.OSS.Iframe] Invoking uploadFile. Parameters:", {
          hasFile: !!file,
          filename: filename,
          fileSize: fileSize,
          fileType: fileType,
          module: params.module
        });

        if (!file) {
          console.error("[ColorboxAI.OSS.Iframe] Error: ColorboxAI.oss.uploadFile requires file parameter (File/Blob)");
          return Promise.reject(new Error("ColorboxAI.oss.uploadFile requires file parameter (File/Blob)"));
        }

        return new Promise(function (resolve, reject) {
          var callbackId = createCallbackId();
          pendingCallbacks[callbackId] = { resolve: resolve, reject: reject };

          var pId = "";
          if (window.ColorboxAI && window.ColorboxAI.project) {
            pId = window.ColorboxAI.project.id || "";
          }

          console.log("[ColorboxAI.OSS.Iframe] Posting postMessage to parent shell.", {
            projectId: pId,
            callbackId: callbackId,
            filename: filename,
            module: params.module || "colorbox-user-upload"
          });

          // 发送二进制 File/Blob 给父页面 Host Shell
          window.parent.postMessage({
            protocol: "colorbox-ai-bridge",
            version: 1,
            direction: "frame-to-host",
            projectId: pId,
            type: "oss.upload",
            payload: {
              file: file,
              filename: filename,
              module: params.module || "colorbox-user-upload",
              callbackId: callbackId
            },
            timestamp: Date.now()
          }, "*");
        });
      }
    };
  }
  

  function track(params) {
    console.log("[ColorboxAI.Standalone] track called. Params:", JSON.stringify(params));
    var next = Object.assign({ act: "onload", pg: globalState.pageTrackCode }, params || {});
    console.log("[ColorboxAI.Standalone] checking window.HupuHpTracer status. Type:", typeof window.HupuHpTracer);
    var hpTracerWhitelist = ["onload", "click", "exposure", "videoact", "access", "onPageOpen", "onPageClose"];
    var isWhitelisted = hpTracerWhitelist.indexOf(next.act) !== -1;
    if (isWhitelisted) {
      if (window.HupuHpTracer && typeof window.HupuHpTracer.track === "function") {
        console.log("[ColorboxAI.Standalone] invoking HupuHpTracer.track with:", JSON.stringify(next));
        window.HupuHpTracer.track(next);
      } else {
        console.warn("[ColorboxAI.Standalone] HupuHpTracer not available or .track is not a function.");
      }
    } else {
      console.log("[ColorboxAI.Standalone] act '" + next.act + "' is NOT in hp-tracer whitelist. Sending via Bridge directly.");
      try {
        var ua = navigator.userAgent || "";
        var isIOS = /\(i[^;]+;( U;)? CPU.+Mac OS X/i.test(ua);
        var payload = {
          method: "hupu.common.hermes",
          data: {
            type: next.act,
            hermes_data: next,
            hermes_key: next.pg
          }
        };
        if (isIOS && window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ClientBridge) {
          console.log("[ColorboxAI.Standalone] iOS bridge direct call:", JSON.stringify(payload));
          window.webkit.messageHandlers.ClientBridge.postMessage(payload);
        } else if (window.androidBridge && window.androidBridge.callNativeAsync) {
          console.log("[ColorboxAI.Standalone] Android bridge direct call:", JSON.stringify(payload));
          window.androidBridge.callNativeAsync("hupu.common.hermes", JSON.stringify({ code: 200, data: payload.data }));
        } else {
          console.warn("[ColorboxAI.Standalone] Bridge not available for direct call.");
        }
      } catch (e) {
        console.error("[ColorboxAI.Standalone] Direct bridge call failed:", e);
      }
    }
  }

  function navigateTo(url, target) {
    console.log("[ColorboxAI.Navigation.Standalone] navigateTo called. URL:", url, "Target:", target);
    if (!url) {
      console.warn("[ColorboxAI.Navigation.Standalone] URL is empty. Aborting navigation.");
      return;
    }
    var navTarget = target || "_blank";
    var ua = navigator.userAgent || "";
    var isHupu = /kanqiu/i.test(ua);
    console.log("[ColorboxAI.Navigation.Standalone] Environment check - isHupu (kanqiu):", isHupu);
    if (isHupu && url.indexOf("huputiyu://") === 0) {
      console.log("[ColorboxAI.Navigation.Standalone] Hupu App Schema detected. Redirecting via window.location.href.");
      window.location.href = url;
    } else {
      if (navTarget === "_blank") {
        console.log("[ColorboxAI.Navigation.Standalone] External target _blank. Opening via window.open.");
        window.open(url, "_blank", "noopener,noreferrer");
      } else {
        console.log("[ColorboxAI.Navigation.Standalone] Redirecting via window.location.href.");
        window.location.href = url;
      }
    }
  }

  window.__colorbox_runtime__ = true;
  window.__colorbox_ai_runtime__ = true;
  window.globalState = globalState;
  window.ColorboxAI = window.ColorboxAI || {
    configure: function (opts) {
      console.log("[ColorboxAI.Standalone] configure called. Opts:", JSON.stringify(opts));
      if (!opts || typeof opts !== "object") return;
      if (opts.trackingCode) {
        globalState.pageTrackCode = String(opts.trackingCode);
      }
      if (opts.pi != null) {
        globalState.pi = String(opts.pi);
      }
    },
    track: track,
    navigateTo: navigateTo,
    openUrl: navigateTo,
    bbs: createColorboxBbsApi(),
    score: createColorboxScoreApi(),
    oss: createColorboxOssApi(),
    getPageTrackCode: function () {
      return globalState.pageTrackCode;
    }
  };
  window.ColorboxAI.navigateTo = window.ColorboxAI.navigateTo || navigateTo;
  window.ColorboxAI.openUrl = window.ColorboxAI.openUrl || navigateTo;
  window.ColorboxAI.bbs = window.ColorboxAI.bbs || createColorboxBbsApi();
  window.ColorboxAI.score = window.ColorboxAI.score || createColorboxScoreApi();
  window.ColorboxAI.oss = window.ColorboxAI.oss || createColorboxOssApi();
})();