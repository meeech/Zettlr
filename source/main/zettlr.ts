/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Zettlr class
 * CVM-Role:        Controller
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This class is the main hub for everything that the main
 *                  process does. This means that here everything the app can
 *                  or cannot do come together.
 *
 * END HEADER
 */

import { app } from 'electron'
import path from 'path'
import fs from 'fs'

// Internal classes
import ZettlrIPC from './zettlr-ipc'
// const ZettlrIPC = require('./zettlr-ipc.js')
import ZettlrWindow from './zettlr-window'
import ZettlrQLStandalone from './zettlr-ql-standalone'
import ZettlrStats from './zettlr-stats'
import FSAL from './modules/fsal'
import { loadI18nMain, trans, findLangCandidates } from '../common/lang/i18n'
import ignoreDir from '../common/util/ignore-dir'
import ignoreFile from '../common/util/ignore-file'
import isDir from '../common/util/is-dir'
import isFile from '../common/util/is-file'
import { commands } from './commands'
import hash from '../common/util/hash'

// const ZettlrWindow = require('./zettlr-window.js')
// const ZettlrQLStandalone = require('./zettlr-ql-standalone.js')
// const ZettlrStats = require('./zettlr-stats.js')
// const FSAL = require('./modules/fsal')
// const { loadI18nMain, trans, findLangCandidates } = require('../common/lang/i18n')
// const ignoreDir = require('../common/util/ignore-dir')
// const ignoreFile = require('../common/util/ignore-file')
// const isDir = require('../common/util/is-dir')
// const isFile = require('../common/util/is-file')
// const { commands } = require('./commands')
// const hash = require('../common/util/hash')

// Service providers
import UpdateProvider from './providers/update-provider'

/**
 * The Zettlr class handles every core functionality of Zettlr. Nothing works
 * without this. One object of Zettlr is created on initialization of the app
 * and will remain in memory until the app is quit completely. It will initialize
 * all additional classes that are needed, as well as prepare everything for
 * the main window to be opened. And, to complicate matters, my aim is to break
 * the 10.000 lines with this behemoth.
 */
class Zettlr {
  isBooting: Boolean
  currentFile: any
  editFlag: Boolean
  _openPaths: any
  _providers: any
  _fsal: any
  ipc: any
  _commands: any
  stats: any
  _ql: any
  window: any

  /**
    * Create a new application object
    * @param {electron.app} parentApp The app object.
    */
  constructor () {
    this.isBooting = true // Only is true until the main process has fully loaded
    // INTERNAL VARIABLES
    this.currentFile = null // Currently opened file (object)
    // this.currentDir = null // Current working directory (object)
    this.editFlag = false // Is the current opened file edited?
    this._openPaths = [] // Holds all currently opened paths.
    this._providers = {} // Holds all app providers (as properties of this object)

    // Inject some globals
    global.application = {
      // Flag indicating whether or not the application is booting
      isBooting: () => { return this.isBooting },
      // TODO: Match the signatures of fileUpdate and dirUpdate
      fileUpdate: (oldHash: Number, fileMetadata: any) => {
        if (typeof fileMetadata === 'number') {
          // NOTE: This will become permanent later on
          fileMetadata = this._fsal.findFile(fileMetadata)
        }
        this.ipc.send('file-replace', {
          'hash': oldHash,
          'file': this._fsal.getMetadataFor(fileMetadata)
        })
      },
      dirUpdate: (oldHash: Number, newHash: Number) => {
        let dir = this._fsal.findDir(newHash)
        this.ipc.send('dir-replace', {
          'hash': oldHash,
          'dir': this._fsal.getMetadataFor(dir)
        })
      },
      notifyChange: (msg: String) => {
        global.ipc.send('paths-update', this._fsal.getTreeMeta())
        global.ipc.notify(msg)
      },
      findFile: (prop: any) => { return this._fsal.findFile(prop) },
      findDir: (prop: any) => { return this._fsal.findDir(prop) },
      // Same as findFile, only with content
      getFile: (fileDescriptor: any) => { return this._fsal.getFileContents(fileDescriptor) }
    }

    // First thing that has to be done is to load the service providers
    this._bootServiceProviders()

    // Load available commands
    this._commands = commands.map(Command => new Command(this))

    // Init translations
    let metadata: any = loadI18nMain(global.config.get('appLang'))

    // It may be that only a fallback has been provided or else. In this case we
    // must update the config to reflect this.
    if (metadata.tag !== global.config.get('appLang')) global.config.set('appLang', metadata.tag)

    // Now that the config provider is definitely set up, let's see if we
    // should copy the interactive tutorial to the documents directory.
    if (global.config.isFirstStart()) {
      global.log.info(`[First Start] Copying over the interactive tutorial to ${app.getPath('documents')}!`)
      this._prepareFirstStart()
    }

    // Boot up the IPC.
    this.ipc = new ZettlrIPC(this)

    // Statistics TODO: Convert to provider
    this.stats = new ZettlrStats(this)

    // Load in the Quicklook window handler class
    // TODO: Convert to provider (or?)
    this._ql = new ZettlrQLStandalone()

    // And the window.
    this.window = new ZettlrWindow(this)

    // File System Abstraction Layer, pass the folder
    // where it can store its internal files.
    this._fsal = new FSAL(app.getPath('userData'))

    // Immediately determine if the cache needs to be cleared
    let shouldClearCache = process.argv.includes('--clear-cache')
    if (global.config.newVersionDetected() || shouldClearCache) {
      global.log.info('Clearing the FSAL cache ...')
      this._fsal.clearCache()
    }

    // Listen to changes in the file system
    this._fsal.on('fsal-state-changed', (objPath: String, info: any) => {
      // Emitted when anything in the state changes
      if (this.isBooting) return // Only propagate these results when not booting
      switch (objPath) {
        case 'activeFile':
          // The active file has changed; set it in the config to
          // have it open again on the next start of the app.
          global.config.set('lastFile', this._fsal.getActiveFile())
          break
        // The root filetree has changed (added or removed root)
        case 'filetree':
          // Nothing specific, so send the full payload
          global.ipc.send('paths-update', this._fsal.getTreeMeta())
          break
        case 'directory':
          // Only a directory has changed
          global.application.dirUpdate(info.oldHash, info.newHash)
          break
        case 'file':
          // Only a file has changed
          global.application.fileUpdate(info.oldHash, info.newHash)
          break
        case 'fileSaved':
          if (!this.isModified()) this.getWindow().clearModified()
          break
        case 'fileContents':
          this._onFileContentsChanged(info)
          break
        case 'openDirectory':
          this.ipc.send('dir-set-current', (this.getCurrentDir()) ? this.getCurrentDir().hash : null)
          global.config.set('lastDir', (this.getCurrentDir()) ? this.getCurrentDir().hash : null)
          break
        case 'openFiles':
          this.ipc.send('sync-files', this._fsal.getOpenFiles())
          global.config.set('openFiles', this._fsal.getOpenFiles())
          if (!this.isModified()) this.getWindow().clearModified()
          break
      }
    })

    process.nextTick(() => {
      let start = Date.now()
      // Read all paths into the app
      this.refreshPaths().then(() => {
        // If there are any, open argv-files
        this.handleAddRoots(global.filesToOpen).then(() => {
          // Reset the global so that no old paths are re-added
          global.filesToOpen = []
          // Verify the integrity of the targets after all paths have been loaded
          global.targets.verify()
          this.isBooting = false // Now we're done booting
          let duration = Date.now() - start
          duration /= 1000 // Convert to seconds
          global.log.info(`Loaded all roots in ${duration} seconds`)

          // Also, we need to (re)open all files in tabs
          this._fsal.setOpenFiles(global.config.get('openFiles'))

          // Now after all paths have been loaded, we are ready to load the
          // main window to get this party started!
          this.openWindow()

          // Finally, initiate a first check for updates
          global.updates.check()
        }).catch((err) => {
          console.error(err)
          global.log.error('Could not add additional roots!', err.message)
          this.isBooting = false // Now we're done booting
        })
      }).catch((err) => {
        console.error(err)
        global.log.error('Could not load paths!', err.message)
        this.isBooting = false // Now we're done booting
      })
    })
  }

  /**
   * Boots the service providers
   * @return {void} Doesn't return
   */
  _bootServiceProviders (): void {
    // NOTE: The order these providers are loaded is important.
    this._providers = {
      'log': require('./providers/log-provider'),
      'config': require('./providers/config-provider'),
      'appearance': require('./providers/appearance-provider'),
      'watchdog': require('./providers/watchdog-provider'),
      'citeproc': require('./providers/citeproc-provider'),
      'dictionary': require('./providers/dictionary-provider'),
      'recentDocs': require('./providers/recent-docs-provider'),
      'tags': require('./providers/tag-provider'),
      'targets': require('./providers/target-provider'),
      'css': require('./providers/css-provider'),
      'translations': require('./providers/translation-provider'),
      'updates': new UpdateProvider()
    }
  }

  /**
   * Callback to perform necessary functions in order to replace file contents.
   *
   * @param {object} info The info object originally passed to the event.
   * @memberof Zettlr
   */
  _onFileContentsChanged (info: any): void {
    let changedFile = this.findFile(info.hash)
    // The contents of one of the open files have changed.
    // What follows looks a bit ugly, welcome to callback hell.
    if (global.config.get('alwaysReloadFiles')) {
      this._fsal.getFileContents(changedFile).then((file: any) => {
        this.ipc.send('replace-file-contents', {
          'hash': info.hash,
          'contents': file.content
        })
      })
    } else {
      // The user did not check this option, so ask first
      this.getWindow().askReplaceFile(changedFile.name, (ret: Number, alwaysReload: Boolean) => {
        // Set the corresponding config option
        global.config.set('alwaysReloadFiles', alwaysReload)
        // ret can have three status: cancel = 0, save = 1, omit = 2.
        if (ret !== 1) return

        this._fsal.getFileContents(changedFile).then((file: any) => {
          this.ipc.send('replace-file-contents', {
            'hash': info.hash,
            'contents': file.content
          })
        })
      }) // END ask replace file
    }
  }

  /**
   * Shuts down all service providers.
   */
  async _shutdownServiceProviders (): Promise<void> {
    for (let provider in this._providers) {
      await this._providers[provider].shutdown()
    }
  }

  /**
    * Shutdown the app. This function is called on quit.
    * @return {Promise} Resolves after the providers have shut down
    */
  async shutdown (): Promise<void> {
    // Close all Quicklook Windows
    this._ql.closeAll()
    // Save the config and stats
    global.config.save()
    this.stats.save()
    // Perform closing activity in the path.
    for (let p of this._openPaths) {
      p.shutdown()
    }

    // Finally shut down the file system
    this._fsal.shutdown()

    // Finally, shut down the service providers
    await this._shutdownServiceProviders()
  }

  /**
    * Returns false if the file should not close, and true if it's safe.
    * @return {Boolean} Either true, if the window can close, or false.
    */
  async canClose (): Promise<Boolean> {
    if (this.isModified()) {
      // There is at least one file currently modified
      let modifiedFiles = this._fsal.getOpenFiles()
        .map((e: Number) => this._fsal.findFile(e))
        .filter((e: any) => e.modified)
        .map((e: any) => e.name) // Hello piping my old friend, I've come to use you once again ...

      let ret = await this.window.askSaveChanges(modifiedFiles)

      // Cancel: abort closing
      if (ret === 0) return false
    }
    return true
  }

  /**
    * This function is mainly called by the browser window to close the app.
    * @return {void} Does not return anything.
    */
  async saveAndClose (): Promise<void> {
    if (await this.canClose()) {
      // "Hard reset" any edit flags that might prevent closing down of the app
      this.getWindow().clearModified()
      let modifiedFiles = this._fsal.getOpenFiles().map((e: Number) => this._fsal.findFile(e))

      // This is the programmatical middle finger to good state management
      for (let file of modifiedFiles) {
        this._fsal.markClean(file)
      }

      app.quit()
    }
  }

  async runCommand (evt: String, arg: any): Promise<any> {
    // This function will be called from IPC with a command and an arg.
    // First find the command
    let cmd = this._commands.find((elem: any) => elem.respondsTo(evt))

    if (cmd) {
      // Return the return value of the command, if there is any
      try {
        return cmd.run(evt, arg)
      } catch (e) {
        global.log.error(e.message, e)
        // Re-throw for the IPC to handle a fall-through
        throw e
      }
    } else {
      // We need to throw, because the return value of a successful command run
      // may very well also evaluate to null, undefined, false or anything else.
      global.log.verbose(`No command registered with the application for command ${evt.toString()}`)
      throw new Error(`No command registered with the application for command ${evt.toString()}`)
    }
  }

  /**
    * Send a new directory list to the client.
    * @param  {Number} arg A hash identifying the directory.
    * @return {void}     This function does not return anything.
    */
  selectDir (arg: Number): void {
    // arg contains a hash for a directory.
    let obj = this._fsal.findDir(arg)

    // Now send it back (the GUI should by itself filter out the files)
    if (obj && obj.type === 'directory') {
      this.setCurrentDir(obj)
    } else {
      global.log.error('Could not find directory', arg)
      this.window.prompt({
        type: 'error',
        title: trans('system.error.dnf_title'),
        message: trans('system.error.dnf_message')
      })
    }
  }

  /**
    * Open a new root.
    */
  async open (): Promise<void> {
    // TODO: Move this to a command
    // The user wants to open another file or directory.
    let ret = await this.window.askDir()
    // Let's see if the user has canceled or not provided a path
    if (ret.canceled || ret.filePaths.length === 0) return
    ret = ret.filePaths[0] // We only need the filePaths property, first element

    if ((isDir(ret) && ignoreDir(ret)) || (isFile(ret) && ignoreFile(ret)) || ret === app.getPath('home')) {
      // We cannot add this dir, because it is in the list of ignored directories.
      global.log.error('The chosen directory is on the ignore list.', ret)
      return this.window.prompt({
        'type': 'error',
        'title': trans('system.error.ignored_dir_title'),
        'message': trans('system.error.ignored_dir_message', path.basename(ret))
      })
    }
    global.ipc.notify(trans('system.open_root_directory', path.basename(ret)))
    await this.handleAddRoots([ret])
    global.ipc.notify(trans('system.open_root_directory_success', path.basename(ret)))
    global.ipc.send('paths-update', this._fsal.getTreeMeta())
  }

  /**
    * Handles a list of files and folders that the user in any way wants to add
    * to the app.
    * @param  {string[]} filelist An array of absolute paths
    */
  async handleAddRoots (filelist: string[]): Promise<void> {
    // As long as it's not a forbidden file or ignored directory, add it.
    let newFile, newDir
    for (let f of filelist) {
      // First check if this thing is already added. If so, simply write
      // the existing file/dir into the newFile/newDir vars. They will be
      // opened accordingly.
      if ((newFile = this._fsal.findFile(f)) != null) {
        // Also set the newDir variable so that Zettlr will automatically
        // navigate to the directory.
        newDir = newFile.parent
      } else if ((newDir = this._fsal.findDir(f)) != null) {
        // Do nothing
      } else if (global.config.addPath(f)) {
        let loaded = await this._fsal.loadPath(f)
        if (!loaded) continue
        let file = this._fsal.findFile(f)
        if (file) this.openFile(file.hash)
      } else {
        global.ipc.notify(trans('system.error.open_root_error', path.basename(f)))
        global.log.error(`Could not open new root file ${f}!`)
      }
    }

    // Open the newly added path(s) directly.
    if (newDir) { this.setCurrentDir(newDir) }
    if (newFile) { this.sendFile(newFile.hash) }
  }

  /**
   * Opens a standalone quicklook window when the renderer requests it
   * @param  {number} hash The hash of the file to be displayed in the window
   * @return {void}      No return.
   */
  openQL (hash: Number): void { this._ql.openQuicklook(this._fsal.findFile(hash)) }

  // /**
  //  * In case a root directory gets removed, indicate that fact by marking it
  //  * dead.
  //  * @param  {ZettlrDir} dir The dir to be removed
  //  * @return {void}     No return.
  //  */
  // makeDead (dir: Object): void {
  //   if (dir === this.getCurrentDir()) this.setCurrentDir(null) // Remove current directory
  //   return console.log(`Marking directory ${dir.name} as dead!`)
  // }

  /**
    * Reloads the complete directory tree.
    * @return {Promise} Resolved after the paths have been re-read
    */
  async refreshPaths (): Promise<void> {
    // Reload all opened files, garbage collect will get the old ones.
    this._fsal.unloadAll()
    for (let p of global.config.get('openPaths')) {
      try {
        await this._fsal.loadPath(p)
      } catch (e) {
        global.log.info(`FSAL Removing path ${String(p).toString()}, as it does no longer exist.`)
        global.config.removePath(p)
      }
    }

    // Set the pointers either to null or last opened dir/file
    let lastDir = null
    let lastFile = null
    try {
      lastDir = this._fsal.findDir(global.config.get('lastDir'))
      lastFile = this._fsal.findFile(global.config.get('lastFile'))
    } catch (e) {
      console.log('Error on finding last dir or file', e)
    }
    this.setCurrentDir(lastDir)
    this.setCurrentFile(lastFile)
    if (lastFile) global.recentDocs.add(this._fsal.getMetadataFor(lastFile))
  }

  findFile (arg: any): any { return this._fsal.findFile(arg) }
  findDir (arg: any): any { return this._fsal.findDir(arg) }

  /**
    * Sets the current file to the given file.
    * @param {Number} f A file hash
    */
  setCurrentFile (f: Number): void {
    this.currentFile = f
    global.config.set('lastFile', f)
  }

  /**
    * Sets the current directory.
    * @param {ZettlrDir} d Directory to be selected.
    */
  setCurrentDir (d: any): void {
    // Set the dir
    this._fsal.setOpenDirectory(d)
  }

  /**
   * Opens the file by moving it into the openFiles array on the FSAL.
   * @param {Number} arg The hash of a file to open
   */
  async openFile (arg: Number): Promise<void> {
    // arg contains the hash of a file.
    // findFile now returns the file object
    let file = this.findFile(arg)

    if (file != null) {
      // Add the file's metadata object to the recent docs
      // We only need to call the underlying function, it'll trigger a state
      // change event and will set in motion all other necessary processes.
      this._fsal.openFile(file)
      global.recentDocs.add(this._fsal.getMetadataFor(file))
      // Also, add to last opened files to persist during reboots
      global.config.addFile(file.path)
      await this.sendFile(file.hash)
    } else {
      global.log.error('Could not find file', arg)
      this.window.prompt({
        type: 'error',
        title: trans('system.error.fnf_title'),
        message: trans('system.error.fnf_message')
      })
    }
  }

  /**
    * Send a file with its contents to the renderer process.
    * @param  {Number} arg An integer containing the file's hash.
    * @return {void}     This function does not return anything.
    */
  async sendFile (arg: Number): Promise<void> {
    // arg contains the hash of a file.
    // findFile now returns the file object
    let file = this._fsal.findFile(arg)

    if (file) {
      try {
        file = await this._fsal.getFileContents(file)
        this.ipc.send('file-open', file)
      } catch (e) {
        const fileName: String = file.name
        global.log.error(`Error sending file! ${fileName.toString()}`, e)
      }
    }
  }

  /**
    * Indicate modifications.
    * @return {void} Nothing to return here.
    */
  setModified (hash: Number): void {
    // Set the modify-indicator on the window
    // and tell the FSAL that a file has been
    // modified.
    let file = this._fsal.findFile(hash)
    if (file) {
      this._fsal.markDirty(file)
      this.window.setModified()
    } else {
      global.log.warning('The renderer reported a modified file, but the FSAL did not find that file.')
    }
  }

  /**
    * Remove the modification flag.
    * @return {void} Nothing to return.
    */
  clearModified (hash: Number): void {
    let file = this._fsal.findFile(hash)
    if (file) {
      this._fsal.markClean(file)
      if (this._fsal.isClean()) this.window.clearModified()
    } else {
      global.log.warning('The renderer reported a saved file, but the FSAL did not find that file.')
    }
  }

  /**
   * This function prepares the app on first start, which includes copying over the tutorial.
   */
  _prepareFirstStart (): void {
    let tutorialPath = path.join(__dirname, 'tutorial')
    let targetPath = path.join(app.getPath('documents'), 'Zettlr Tutorial')
    let availableLanguages = fs.readdirSync(tutorialPath, { 'encoding': 'utf8' })

    let candidates = availableLanguages
      .map(e => { return { 'tag': e, 'path': path.join(tutorialPath, e) } })
      .filter(e => isDir(e.path))

    let { exact, close } = findLangCandidates(global.config.get('appLang'), candidates) as any

    let tutorial = path.join(tutorialPath, 'en')
    if (exact) tutorial = exact.path
    if (!exact && close) tutorial = close.path

    // Now we have both a target and a language candidate, let's copy over the files!
    try {
      fs.lstatSync(targetPath)
      // Already exists! Abort!
      global.log.error(`The directory ${targetPath} already exists - won't overwrite!`)
      return
    } catch (e) {
      fs.mkdirSync(targetPath)

      // Now copy over every file from the directory
      let contents = fs.readdirSync(tutorial, { 'encoding': 'utf8' })
      for (let file of contents) {
        fs.copyFileSync(path.join(tutorial, file), path.join(targetPath, file))
      }
      global.log.info('Successfully copied the tutorial files', contents)

      // Now the last thing to do is set it as open
      global.config.addPath(targetPath)
      // Also set the welcome.md as open
      global.config.addFile(path.join(targetPath, 'welcome.md'))
      // ALSO the directory needs to be opened
      global.config.set('lastDir', hash(targetPath))
    }
  }

  /**
   * Convenience function to send a full file object to the renderer
   */
  sendPaths (): void { global.ipc.send('paths-update', this._fsal.getTreeMeta()) }

  /**
   * Sends all currently opened files to the renderer
   */
  sendOpenFiles (): void { global.ipc.send('sync-files', this._fsal.getOpenFiles()) }

  // Getters

  /**
    * Returns the window instance.
    * @return {ZettlrWindow} The main window
    */
  getWindow (): ZettlrWindow { return this.window }

  /**
    * Returns the IPC instance.
    * @return {ZettlrIPC}  The IPC object
    */
  getIPC (): ZettlrIPC { return this.ipc }

  /**
    * Returns the stats
    * @return {ZettlrStats} The stats object.
    */
  getStats (): ZettlrStats { return this.stats }

  /**
    * Get the current directory.
    * @return {ZettlrDir} Current directory.
    */
  getCurrentDir (): any { return this._fsal.getOpenDirectory() }

  /**
    * Return the current file.
    * @return {Mixed} ZettlrFile or null.
    */
  getCurrentFile (): any { return this.currentFile }

  /**
   * Returns the File System Abstraction Layer
   */
  getFileSystem (): FSAL { return this._fsal }

  /**
    * Are there unsaved changes currently in the file system?
    * @return {Boolean} Return true, if there are unsaved changes, or false.
    */
  isModified (): Boolean { return !this._fsal.isClean() }

  /**
    * Open a new window.
    * @return {void} This does not return.
    */
  openWindow (): void { this.window.open() }

  /**
    * Close the current window.
    * @return {void} Does not return.
    */
  closeWindow (): void { this.window.close() }
}

// Export the module on require()
module.exports = Zettlr
