/*jshint -W083 */
var H5PUpgrades = H5PUpgrades || {};

H5P.ContentUpgradeProcess = (function (Version) {

  /**
   * @class
   * @namespace H5P
   */
  function ContentUpgradeProcess(name, oldVersion, newVersion, params, id, loadLibrary, done) {
    var self = this;

    // Make params possible to work with
    try {
      params = JSON.parse(params);
      if (!(params instanceof Object)) {
        throw true;
      }
    }
    catch (event) {
      return done({
        type: 'errorParamsBroken',
        id: id
      });
    }

    self.loadLibrary = loadLibrary;
    self.upgrade(name, oldVersion, newVersion, params, function (err, result) {
      if (err) {
        return done(err);
      }

      done(null, JSON.stringify(params));
    });
  }

  /**
   *
   */
  ContentUpgradeProcess.prototype.upgrade = function (name, oldVersion, newVersion, params, done) {
    var self = this;

    // Load library details and upgrade routines
    self.loadLibrary(name, newVersion, function (err, library) {
      if (err) {
        return done(err);
      }

      // Run upgrade routines on params
      self.processParams(library, oldVersion, newVersion, params, function (err, params) {
        if (err) {
          return done(err);
        }

        // Check if any of the sub-libraries need upgrading
        asyncSerial(library.semantics, function (index, field, next) {
          self.processField(field, params[field.name], function (err, upgradedParams) {
            if (upgradedParams) {
              params[field.name] = upgradedParams;
            }
            next(err);
          });
        }, function (err) {
          done(err, params);
        });
      });
    });
  };

  /**
   * Run upgrade hooks on params.
   *
   * @public
   * @param {Object} library
   * @param {Version} oldVersion
   * @param {Version} newVersion
   * @param {Object} params
   * @param {Function} next
   */
  ContentUpgradeProcess.prototype.processParams = function (library, oldVersion, newVersion, params, next) {
    if (H5PUpgrades[library.name] === undefined) {
      if (library.upgradesScript) {
        // Upgrades script should be loaded so the upgrades should be here.
        return next({
          type: 'scriptMissing',
          library: library.name + ' ' + newVersion
        });
      }

      // No upgrades script. Move on
      return next(null, params);
    }

    // Run upgrade hooks. Start by going through major versions
    asyncSerial(H5PUpgrades[library.name], function (major, minors, nextMajor) {
      if (major < oldVersion.major || major > newVersion.major) {
        // Older than the current version or newer than the selected
        nextMajor();
      }
      else {
        // Go through the minor versions for this major version
        asyncSerial(minors, function (minor, upgrade, nextMinor) {
          if (minor <= oldVersion.minor || minor > newVersion.minor) {
            // Older than or equal to the current version or newer than the selected
            nextMinor();
          }
          else {
            // We found an upgrade hook, run it
            var unnecessaryWrapper = (upgrade.contentUpgrade !== undefined ? upgrade.contentUpgrade : upgrade);

            try {
              unnecessaryWrapper(params, function (err, upgradedParams) {
                params = upgradedParams;
                nextMinor(err);
              });
            }
            catch (err) {
              if (console && console.log) {
                console.log("Error", err.stack);
                console.log("Error", err.name);
                console.log("Error", err.message);
              }
              next(err);
            }
          }
        }, nextMajor);
      }
    }, function (err) {
      next(err, params);
    });
  };

  /**
   * Process parameter fields to find and upgrade sub-libraries.
   *
   * @public
   * @param {Object} field
   * @param {Object} params
   * @param {Function} done
   */
  ContentUpgradeProcess.prototype.processField = function (field, params, done) {
    var self = this;

    if (params === undefined) {
      return done();
    }

    switch (field.type) {
      case 'library':
        if (params.library === undefined || params.params === undefined) {
          return done();
        }

        // Look for available upgrades
        var usedLib = params.library.split(' ', 2);
        for (var i = 0; i < field.options.length; i++) {
          var availableLib = field.options[i].split(' ', 2);
          if (availableLib[0] === usedLib[0]) {
            if (availableLib[1] === usedLib[1]) {
              return done(); // Same version
            }

            // We have different versions
            var usedVer = new Version(usedLib[1]);
            var availableVer = new Version(availableLib[1]);
            if (usedVer.major > availableVer.major || (usedVer.major === availableVer.major && usedVer.minor >= availableVer.minor)) {
              return done(); // Larger or same version that's available
            }

            // A newer version is available, upgrade params
            return self.upgrade(availableLib[0], usedVer, availableVer, params.params, function (err, upgraded) {
              if (!err) {
                params.library = availableLib[0] + ' ' + availableVer.major + '.' + availableVer.minor;
                params.params = upgraded;
              }
              done(err, params);
            });
          }
        }
        done();
        break;

      case 'group':
        if (field.fields.length === 1) {
          // Single field to process, wrapper will be skipped
          self.processField(field.fields[0], params, function (err, upgradedParams) {
            if (upgradedParams) {
              params = upgradedParams;
            }
            done(err, params);
          });
        }
        else {
          // Go through all fields in the group
          asyncSerial(field.fields, function (index, subField, next) {
            var paramsToProcess = params ? params[subField.name] : null;
            self.processField(subField, paramsToProcess, function (err, upgradedParams) {
              if (upgradedParams) {
                params[subField.name] = upgradedParams;
              }
              next(err);
            });

          }, function (err) {
            done(err, params);
          });
        }
        break;

      case 'list':
        // Go trough all params in the list
        asyncSerial(params, function (index, subParams, next) {
          self.processField(field.field, subParams, function (err, upgradedParams) {
            if (upgradedParams) {
              params[index] = upgradedParams;
            }
            next(err);
          });
        }, function (err) {
          done(err, params);
        });
        break;

      default:
        done();
    }
  };

  /**
   * Helps process each property on the given object asynchronously in serial order.
   *
   * @private
   * @param {Object} obj
   * @param {Function} process
   * @param {Function} finished
   */
  var asyncSerial = function (obj, process, finished) {
    var id, isArray = obj instanceof Array;

    // Keep track of each property that belongs to this object.
    if (!isArray) {
      var ids = [];
      for (id in obj) {
        if (obj.hasOwnProperty(id)) {
          ids.push(id);
        }
      }
    }

    var i = -1; // Keeps track of the current property

    /**
     * Private. Process the next property
     */
    var next = function () {
      id = isArray ? i : ids[i];
      process(id, obj[id], check);
    };

    /**
     * Private. Check if we're done or have an error.
     *
     * @param {String} err
     */
    var check = function (err) {
      // We need to use a real async function in order for the stack to clear.
      setTimeout(function () {
        i++;
        if (i === (isArray ? obj.length : ids.length) || (err !== undefined && err !== null)) {
          finished(err);
        }
        else {
          next();
        }
      }, 0);
    };

    check(); // Start
  };

  return ContentUpgradeProcess;
})(H5P.Version);
