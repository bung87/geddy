/**
* A responder determines the best way to respond to a request
* @constructor
* @param {Object} controller - The controller that owns this Responder
*/
var errors = require('../../response/errors')
  , utils = require('utilities')
  , response = require('../../response')
  , Responder = function (controller) {
      var self = this
          // Default strategies
        , respondWithStrategies = {
            html: require('./strategies/html')

            // Eventually these should be unique...
          , json: require('./strategies/api')
          , xml: require('./strategies/api')
          , js: require('./strategies/api')
          , txt: require('./strategies/api')
          };

      // Convenient aliases for stuff we need in the controller
      // Everything here needs to be in the controller shim
      // for testing purposes
      this.params = controller.params
      this.flash = controller.flash
      this.headers = controller.request.headers
      this.formats = controller.respondsWith
      this.doResponse = controller._doResponse
      this.throwUndefinedFormatError = function () {
            var err = new errors.InternalServerError(
              'Format not defined in response.formats.');
            throw err;
          };
      this.redirect = function () {
        // Delegate to the controller
        controller.redirect.apply(controller, arguments);
      };

      /**
      * Determines if the Responder can service a request
      * @param {String} [frmt] - The format requested e.g. 'json'
      * @param {Object} [strategies] - A hash of user-defined strategies
      * @returns {Object} - A hash with the signature
      *   `{format: String, contentType: String}`
      */
      this.negotiate = function (frmt, strategies) {
        var format
          , contentType
          , types = []
          , accepts = this.headers.accept
          , wildcard = false
          , match
          , err
          , accept
          , pat
          , i
            // Clone accepted formats
          , acceptFormats = this.formats.slice(0);

        strategies = strategies || {};

        // Copy in additional formats from the user's custom strategies
        for(var key in strategies) {
          if(acceptFormats.indexOf(key) < 0) {
            acceptFormats.push(key);
          }
        }

        // If client provides an Accept header, split on comma
        // - some user-agents include whitespace with the comma
        if (accepts) {
          accepts = accepts.split(/\s*,\s*/);
        }
        // If no Accept header is found, assume it's happy with anything
        else {
          accepts = ['*/*'];
        }

        // If a format was requested as an argument use it
        if (frmt) {
          types = [frmt];
        }
        // Otherwise check the request params
        else if (this.params.format) {
          var f = this.params.format;
          // TODO test var with formats

          // If we can respond with the requested format then assign it to types
          if (acceptFormats.indexOf(f) >= 0) {
            types = [f];
          }
        }
        // Otherwise assign all possible formats
        else {
          types = acceptFormats;
        }

        // See if any format types match the accept header
        if (types.length) {
          for (var i = 0, ii = accepts.length; i < ii; i++) {
            accept = accepts[i].split(';')[0]; // Ignore quality factors

            if (accept == '*/*') {
              wildcard = true;
              break;
            }
          }

          // If agent accepts anything, respond with controller's first choice
          if (wildcard) {
            var t = types[0];

            format = t;
            contentType = response.getContentTypeForFormat(t);

            // Controllers should at least one format with a valid contentType
            if (!contentType) {
              this.throwUndefinedFormatError();
              return;
            }
          }
          // Otherwise look through acceptable formats and see if Geddy knows about them
          else {
            for (var i = 0, ii = types.length; i < ii; i++) {
              match = response.matchAcceptHeaderContentType(accepts, types[i]);

              if (match) {
                format = types[i];
                contentType = match;
                break;
              }
              else {
                // Geddy doesn't know about this format
                this.throwUndefinedFormatError();
                return;
              }
            }
          }
        }
        else {
          this.throwUndefinedFormatError();
          return;
        }

        return {
          format: format
        , contentType: contentType
        };
      };

      /**
      * Responds with a model or collection
      * @param {Object} content - The model, collection, or hash of values
      * @param {Object} [options] Options.
      *   @param {String|Object} [options.status] The desired flash message,
      *     can be a string or an errors hash
      *   @param {Boolean} [options.silent] Disables flash messages if set to true
      * @param {Function} [cb] - An optional callback where the first argument
      *   is the response buffer
      */
      this.respondWith = function (content, opts, cb) {
        opts = opts || {};

        var type;

        // Determine the type of model from the content
        if(content instanceof Array) {
          if(content.length) {
            type = content[0].type.toLowerCase()
          }
          else {
            // No way to determine from empty array
            type = null;
          }
        }
        else {
          type = content.type.toLowerCase()
        }

        // If the user supplied a type use it
        if(opts.type) {
          type = opts.type;
        }

        // Supply this 'type' as an option so the strategies can use it
        opts.type = type;

        this.respondTo(content, respondWithStrategies, opts, cb);
      };

      /**
      * Delegates respond tasks to user-defined strategy functions
      * @param {Object} content - The hash of values
      * @param {Object} [strategies] - The strategies to use.
      *   Will be run in the Responder context
      *   e.g { json: function(content, negotiated){} }
      * @param {Object} [options] Options to pass to the strategies
      * @param {Function} [cb] - An optional callback where the first argument
      *   is the response buffer
      */
      this.respondTo = function (content, strategies, opts, cb) {
        strategies = strategies || {};
        opts = opts || {}

        var negotiated = this.negotiate(null, strategies);
        opts = utils.mixin({}, opts, negotiated);

        // Error during content negotiation may result in an error response, so
        // - don't continue
        if (controller.completed) {
          return;
        }

        // Was the negotiated type a user-defined strategy?
        if(typeof strategies[negotiated.format] === 'function') {
          strategies[negotiated.format].call(this, content, opts, cb);
        }
        else {
          //The default action is to use respond
          this.respond(content, opts, cb);
        }
      };

      /**
      * Lower level respond function that expects stuff like
      * content-negotiation to have been done by a strategy.
      * @param {Object} content - The model, collection, or hash of values
      * @param {Object} options - The required options hash
      *   @param {String} options.format - The negotiated format e.g. "json"
      *   @param {String} options.contentType - The negotiated content type
      *     e.g. "text/plain"
      *   @param {Function} [cb] - An optional callback where the first argument
      *     is the response buffer
      */
      this.respond = function (content, options, cb) {
        var opts = options || {}
          , formatCb = function (formattedContent) {
              // Delegate to the controller's _doResponse
              self.doResponse.call(controller
                , opts.statusCode || 200
                , {'Content-Type': opts.contentType}
                , formattedContent
                , cb);
            };

        // Hand content off to formatting along with callback for writing out
        // the formatted respnse
        response.formatContent(opts.format, content, controller, opts, formatCb);
      };
    };

module.exports = Responder;