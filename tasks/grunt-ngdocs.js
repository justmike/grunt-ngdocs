/*
 * grunt-ngdocs
 * https://github.com/m7r/grunt-ngdocs
 *
 * Copyright (c) 2013 m7r
 * Licensed under the MIT license.
 */

var reader = require('../src/reader.js'),
    ngdoc = require('../src/ngdoc.js'),
    path = require('path'),
    vm = require('vm'),
    DOM = require('../src/dom.js').DOM;

var repohosts = [
  { re: /https?:\/\/github.com\/([^\/]+\/[^\/]+)|git@github.com:(.*)/,
    reSuffix: /\.git.*$/,
    sourceLink: 'https://github.com/{{repo}}/blob/{{sha}}/{{file}}#L{{codeline}}',
    editLink: 'https://github.com/{{repo}}/edit/master/{{file}}'
  }
];

module.exports = function(grunt) {
  var _ = grunt.util._,
      unittest = {},
      templates = path.resolve(__dirname, '../src/templates');

  grunt.registerMultiTask('ngdocs', 'build documentation', function() {
    var start = now(),
        pkg = getPackage(),
        done = this.async(),
        options = this.options({
          dest: 'docs/',
          startPage: '/api',
          scripts: ['angular.js'],
          styles: [],
          title: pkg.title || pkg.name || '',
          html5Mode: false,
          editExample: true,
          sourceLink: true,
          editLink: true,
          inlinePartials: false
        }),
        section = this.target === 'all' ? 'api' : this.target,
        setup;

    //Copy the scripts into their own folder in docs, unless they are remote or default angular.js
    var linked = /^((https?:)?\/\/|\.\.\/)/;
    var gruntScriptsFolder = 'grunt-scripts';
    var gruntStylesFolder = 'grunt-styles';

  	// If the options.script is an array of arrays ( useful when working with variables, for example: ['<%= vendor_files %>','<%= app_files %>'] )
  	// convert to a single array with _.flatten ( http://underscorejs.org/#flatten )
  	options.scripts = _.flatten(options.scripts);
    options.scripts = _.map(options.scripts, function(file) {
      if (file === 'angular.js') {
        return 'js/angular.min.js';
      }

      if (linked.test(file)) {
        return file;
      }

      var filename = file.split('/').pop();
      //Use path.join here because we aren't sure if options.dest has / or not
      grunt.file.copy(file, path.join(options.dest, gruntScriptsFolder, filename));

      //Return the script path: doesn't have options.dest in it, it's relative
      //to the docs folder itself
      return gruntScriptsFolder + '/' + filename;
    });

    if (options.image && !linked.test(options.image)) {
      grunt.file.copy(options.image, path.join(options.dest, gruntStylesFolder, options.image));
      options.image = gruntStylesFolder + '/' + options.image;
    }

    options.styles = _.map(options.styles, function(file) {
      if (linked.test(file)) {
        return file;
      }
      var filename = file.split('/').pop();
      grunt.file.copy(file, path.join(options.dest, 'css', filename));
      return 'css/' + filename;
    });

    setup = prepareSetup(section, options);

    grunt.log.writeln('Generating Documentation...');

    prepareLinks(pkg, options);

    reader.docs = [];
    this.files.forEach(function(f) {
      options.isAPI = f.api || section == 'api';
      setup.sections[section] = f.title || 'API Documentation';
      setup.apis[section] = options.isAPI;
      f.src.filter(exists).forEach(function(filepath) {
        var content = grunt.file.read(filepath);
        reader.process(content, filepath, section, options);
      });
    });

    ngdoc.merge(reader.docs);

    reader.docs.forEach(function(doc){
      // this hack is here because on OSX angular.module and angular.Module map to the same file.
      var id = doc.id.replace('angular.Module', 'angular.IModule').replace(':', '.'),
          file = path.resolve(options.dest, 'partials', doc.section, id + '.html');
      grunt.file.write(file, doc.html());
    });

    ngdoc.checkBrokenLinks(reader.docs, setup.apis, options);

    setup.pages = _.union(setup.pages, ngdoc.metadata(reader.docs));

    if (options.generatePartialsTodoIndex || options.doNotGenerateStandardIndexHtml) {
      var foundSectionTodo = setup.pages.some(function(page) {
        return page.section === 'todo';
      });
      if (!foundSectionTodo) {
        setup.pages.push({
          "section": "todo",
          "id": "index",
          "shortName": "TODO",
          "type": "overview",
          "moduleName": "TODO",
          "sourceFile": "docs/content/todo/",
          "shortDescription": "To Dos",
          "keywords": "overview todo todos"
        });
      }
    }

    if (options.generatePartialsTodoIndex) {
      generatePartialsTodoIndex(options, parseTodos(reader.docs));
    }

    if (options.navTemplate) {
      options.navContent = grunt.template.process(grunt.file.read(options.navTemplate));
    } else {
      options.navContent = '';
    }

    writeSetup(setup);

    if (options.inlinePartials) {
      inlinePartials(path.resolve(options.dest, 'index.html'), path.resolve(options.dest, 'partials'));
    }

    grunt.log.writeln('DONE. Generated ' + reader.docs.length + ' pages in ' + (now()-start) + 'ms.');
    done();
  });

  function getPackage() {
    var pkg = grunt.config('pkg');
    try {
      pkg = grunt.file.readJSON('package.json');
    } catch (e) {}
    return pkg || {};
  }

  function generatePartialsTodoIndex(options, todosByFile) {
    var todoFilePath = path.resolve(options.dest, 'partials', 'todo', 'index.html');
    var dom = new DOM();
    if (todosByFile && todosByFile.todoCount > 0) {
      dom.h('To Do', function() {
        dom.p(function() {
          dom.text(todosByFile.todoCount + ' ');
          dom.tag('code', '@todo');
          dom.text('items found in ' + todosByFile.fileCount + ' files.');
        });

        Object.keys(todosByFile.todosByFile).sort().forEach(function(fileName) {
          var todoFile = todosByFile.todosByFile[fileName];
          var fileSections = todoFile.sections;

          dom.h(todoFile.fileName, function() {
            // always show the "file" section first
            var sections = Object.keys(fileSections).sort();
            var fileSectionIndex = sections.indexOf('file');
            if (fileSectionIndex) {
              sections.splice(0, 0, sections.splice(fileSectionIndex, 1)[0]); // http://stackoverflow.com/a/2440723/12293
            }
            sections.forEach(function(sectionName) {
              var fileSection = fileSections[sectionName];

              if (fileSection.sectionName !== 'file') {
                dom.tag('h3', fileSection.sectionName);
              }
              dom.tag('ul', function() {
                fileSection.todos.forEach(function(todo) {
                  dom.tag('li', function() {
                    // don't htmlEscape() the output
                    dom.out.push(todo.full);
                  });
                });
              });
            });
          });
        });
      });
      grunt.log.writeln('Generated "partials/todo/index.html" (' + todosByFile.todoCount + ' items in ' + todosByFile.fileCount + ' files)');
    } else {
      dom.h('To Do', function() {
        dom.p(function() {
          dom.text('You have no ');
          dom.tag('code', '@todo');
          dom.text('items!');
        });
      });
      grunt.log.writeln('Generated empty "partials/todo/index.html" (no "@todo" items found!)');
    }

    grunt.file.write(todoFilePath, dom.toString());
  }

  function parseTodos(docs) {
    var todosByFile = {};
    var todoCount = 0;
    docs.forEach(function(doc, fileIndex) {
      var todoFile = todosByFile[doc.file];
      if (!todoFile) {
        todoFile = {
          fileName: doc.file,
          sections: {}
        };
      }
      var fileSections = todoFile.sections;
      var fileSection;

      var sectionName;

      if (doc.todos.length > 0) {
        sectionName = 'file';
        fileSection = fileSections[sectionName];
        if (!fileSection) {
          fileSection = {
            sectionName: sectionName,
            todos: []
          };
          fileSections[sectionName] = fileSection;
          todosByFile[doc.file] = todoFile;  // initialize
          todoFile.sections = fileSections;
          todoFile.sequence = fileIndex;
        }

        doc.todos.forEach(function(todo, todoIndex) {
          fileSection.todos.push(todo);
          ++todoCount;
        });
      }
      doc.methods.forEach(function(method) {
        sectionName = method.name;
        fileSection = fileSections[sectionName];
        method.todos.forEach(function(todo, todoIndex) {
          if (!fileSection) {
            fileSection = {
              sectionName: sectionName,
              todos: []
            };
            fileSections[sectionName] = fileSection;
            todosByFile[doc.file] = todoFile;  // initialize
            todoFile.sections = fileSections;
            todoFile.sequence = fileIndex;
          }
          fileSection.todos.push(todo);
          ++todoCount;
        });
      });
    });
    var fileCount = Object.keys(todosByFile).length;
    if (fileCount > 0) {
      return {
        fileCount: fileCount,
        todoCount: todoCount,
        todosByFile: todosByFile
      };
    }
  }

  function makeLinkFn(tmpl, values) {
      if (!tmpl || tmpl === true) { return false; }
      if (/\{\{\s*sha\s*\}\}/.test(tmpl)) {
        var shell = require('shelljs');
        var sha = shell.exec('git rev-parse HEAD', { silent: true });
        values.sha = ('' + sha.output).slice(0, 7);
      }
      tmpl = _.template(tmpl, undefined, {'interpolate': /\{\{(.+?)\}\}/g});
      return function(file, line, codeline) {
        values.file = file;
        values.line = line;
        values.codeline = codeline;
        values.filepath = path.dirname(file);
        values.filename = path.basename(file);
        return tmpl(values);
      };
    }

  function prepareLinks(pkg, options) {
    var values = {version: pkg.version || 'master'};
    var url = (pkg.repository || {}).url;

    if (url && options.sourceLink === true || options.sourceEdit === true) {
      repohosts.some(function(host) {
        var match = url.match(host.re);
        if (match) {
          values.repo = match[1] || match[2];
          if (host.reSuffix) {
            values.repo = values.repo.replace(host.reSuffix, '');
          }
          if (host.sourceLink && options.sourceLink === true) {
            options.sourceLink = host.sourceLink;
          }
          if (host.editLink && options.editLink === true) {
            options.editLink = host.editLink;
          }
        }
        return match;
      });
    }
    options.sourceLink = makeLinkFn(options.sourceLink, values);
    options.editLink = makeLinkFn(options.editLink, values);
  }

  unittest.prepareLinks = prepareLinks;

  function prepareSetup(section, options) {
    var setup, data, context = {},
        file = path.resolve(options.dest, 'js/docs-setup.js');
    if (exists(file)) {
      // read setup from file
      data = grunt.file.read(file);
      vm.runInNewContext(data, context, file);
      setup = context.NG_DOCS;
      // keep only pages from other build tasks
      setup.pages = _.filter(setup.pages, function(p) {return p.section !== section;});
    } else {
      // build clean dest
      setup = {sections: {}, pages: [], apis: {}};
      copyTemplates(options.dest);
    }
    setup.__file = file;
    setup.__options = options;
    return setup;
  }

  function writeSetup(setup) {
    var options = setup.__options,
        content, data = {
          scripts: options.scripts,
          styles: options.styles,
          sections: _.keys(setup.sections).join('|'),
          discussions: options.discussions,
          analytics: options.analytics,
          navContent: options.navContent,
          title: options.title,
          image: options.image,
          titleLink: options.titleLink,
          imageLink: options.imageLink,
          bestMatch: options.bestMatch,
          deferLoad: !!options.deferLoad
        },
        template = options.template ? options.template : path.resolve(templates, 'index.tmpl');

    // create index.html
    content = grunt.file.read(template);
    content = grunt.template.process(content, {data:data});
    grunt.file.write(path.resolve(options.dest, 'index.html'), content);

    // create setup file
    setup.html5Mode = options.html5Mode;
    setup.editExample = options.editExample;
    setup.startPage = options.startPage;
    setup.discussions = options.discussions;
    setup.scripts = _.map(options.scripts, function(url) { return path.basename(url); });
    grunt.file.write(setup.__file, 'NG_DOCS=' + JSON.stringify(setup, replacer, 2) + ';');
  }


  function copyTemplates(dest) {
    grunt.file.expandMapping(['**/*', '!**/*.tmpl'], dest, {cwd: templates}).forEach(function(f) {
      var src = f.src[0],
          dest = f.dest;
      if (grunt.file.isDir(src)) {
          grunt.file.mkdir(dest);
        } else {
          grunt.file.copy(src, dest);
        }
    });
  }

  function inlinePartials(indexFile, partialsFolder) {
    var indexFolder = path.dirname(indexFile);
    var partials = grunt.file.expand(partialsFolder + '/**/*.html').map(function(partial){
      return path.relative(indexFolder, partial);
    });
    var html = partials.map(function(partial){
      // Get the partial content and replace the closing script tags with a placeholder
      var partialContent = grunt.file.read(path.join(indexFolder, partial))
        .replace(/<\/script>/g, '<___/script___>');
      return '<script type="text/ng-template" id="' + partial + '">' + partialContent + '<' + '/script>';
    }).join('');
    // During page initialization replace the placeholder back to the closing script tag
    // @see https://github.com/angular/angular.js/issues/2820
    html += '<script>(' + (function() {
      var scripts = document.getElementsByTagName("script");
      for (var i=0;i<scripts.length;i++) {
        if (scripts[i].type==='text/ng-template') {
          scripts[i].innerHTML = scripts[i].innerHTML.replace(/<___\/script___>/g, '</' + 'script>');
        }
      }
    }) + '())</script>';
    // Inject the html into the ngdoc file
    var patchedIndex = grunt.file.read(indexFile).replace(/<body[^>]*>/i, function(match) {
      return match + html;
    });
    grunt.file.write(indexFile, patchedIndex);
    // Remove the partials
    partials.forEach(function(partial) {
      grunt.file.delete(path.join(indexFolder, partial));
    });
  }

  function exists(filepath) {
    return !!grunt.file.exists(filepath);
  }

  function replacer(key, value) {
    if (key.substr(0,2) === '__') {
      return undefined;
    }
    return value;
  }

  function now() { return new Date().getTime(); }

  return unittest;
};
