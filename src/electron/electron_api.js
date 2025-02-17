import { ipcMain, shell } from "electron";
import fs from "fs";
import path from "path";
import { marked } from "marked";
import mkdirp from "mkdirp";

import { execaSync } from "execa";
import cables from "../cables.js";
import logger from "../utils/logger.js";
import doc from "../utils/doc_util.js";
import helper from "../utils/helper_util.js";
import opsUtil from "../utils/ops_util.js";
import subPatchOpUtil from "../utils/subpatchop_util.js";
import settings from "./electron_settings.js";
import projectsUtil from "../utils/projects_util.js";
import electronApp from "./main.js";
import filesUtil from "../utils/files_util.js";

class ElectronApi
{
    constructor()
    {
        this._log = logger;
    }

    init()
    {
        ipcMain.handle("talkerMessage", async (event, cmd, data, topicConfig = {}) =>
        {
            try
            {
                return this.talkerMessage(cmd, data, topicConfig);
            }
            catch (e)
            {
                return this.error(e.message, e);
            }
        });

        ipcMain.on("settings", (event, _cmd, _data) =>
        {
            settings.data.buildInfo = settings.getBuildInfo();
            event.returnValue = settings.data;
        });

        ipcMain.on("config", (event, _cmd, _data) =>
        {
            event.returnValue = cables.getConfig();
        });

        ipcMain.on("getOpDir", (event, data) =>
        {
            let opName = data.name;
            if (!opName) opName = opsUtil.getOpNameById(data.opId);
            event.returnValue = opsUtil.getOpAbsolutePath(opName);
        });
    }

    async talkerMessage(cmd, data, topicConfig = {})
    {
        let response = null;
        if (!cmd) return this.error("UNKNOWN_COMMAND");
        if (typeof this[cmd] === "function")
        {
            if (topicConfig.needsProjectFile)
            {
                const projectFile = settings.getCurrentProjectFile();
                if (!projectFile || !projectFile.endsWith(projectsUtil.CABLES_PROJECT_FILE_EXTENSION))
                {
                    const newProjectFile = await electronApp.saveProjectFileDialog();
                    if (newProjectFile)
                    {
                        const currentProject = settings.getCurrentProject();
                        projectsUtil.writeProjectToFile(newProjectFile, currentProject);
                        this.loadProject(newProjectFile);
                    }
                    else
                    {
                        return this.error("no project dir chosen");
                    }
                }
            }
            return this[cmd](data);
        }
        else
        {
            this._log.warn("no method for talkerMessage", cmd);
        }
        return response;
    }

    getOpInfo(data)
    {
        const name = data.opName;
        let warns = [];
        try
        {
            warns = opsUtil.getOpCodeWarnings(name);

            if (opsUtil.isOpNameValid(name))
            {
                const result = { "warns": warns };
                result.attachmentFiles = opsUtil.getAttachmentFiles(name);
                return this.success(result, true);
            }
            else
            {
                const result = { "warns": warns };
                result.attachmentFiles = [];
                return this.success(result, true);
            }
        }
        catch (e)
        {
            this._log.warn("error when getting opinfo", name, e.message);
            const result = { "warns": warns };
            result.attachmentFiles = [];
            return this.success(result, true);
        }
    }

    async savePatch(patch)
    {
        const currentProject = settings.getCurrentProject();
        const currentProjectFile = settings.getCurrentProjectFile();

        const re = {
            "msg": "PROJECT_SAVED"
        };
        currentProject.updated = Date.now();
        currentProject.updatedByUser = settings.getCurrentUser().username;
        projectsUtil.writeProjectToFile(currentProjectFile, currentProject, patch);
        this.loadProject(currentProjectFile);
        re.updated = currentProject.updated;
        re.updatedByUser = currentProject.updatedByUser;
        return this.success(re, true);
    }

    async patchCreateBackup()
    {
        const re = {
            "msg": "BACKUP_CREATED"
        };
        const currentProject = settings.getCurrentProject();
        const projectFile = await electronApp.saveProjectFileDialog("export");
        if (!projectFile)
        {
            logger.info("no backup file chosen");
            return this.error("UNKNOWN_PROJECT");
        }

        const backupProject = projectsUtil.getBackup(currentProject);
        fs.writeFileSync(projectFile, JSON.stringify(backupProject));
        return this.success(re, true);
    }

    getPatch()
    {
        const patchPath = settings.getCurrentProjectFile();
        const currentUser = settings.getCurrentUser();
        let currentProject = settings.getCurrentProject();
        if (patchPath && fs.existsSync(patchPath))
        {
            currentProject = fs.readFileSync(patchPath);
            currentProject = JSON.parse(currentProject.toString("utf-8"));
            if (!currentProject.hasOwnProperty("userList")) currentProject.userList = [currentUser];
            if (!currentProject.hasOwnProperty("teams")) currentProject.teams = [];
        }
        else
        {
            if (!currentProject)
            {
                const newProject = projectsUtil.generateNewProject(settings.getCurrentUser());
                this.loadProject(patchPath, newProject);
                currentProject = newProject;
            }
        }
        currentProject.allowEdit = true;
        currentProject.summary = currentProject.summary || {};
        currentProject.summary.title = currentProject.name;
        currentProject.summary.allowEdit = true;
        return this.success(currentProject, true);
    }

    async newPatch()
    {
        electronApp.openPatch();
        return this.success(true, true);
    }

    fileUpload(data)
    {
        const target = cables.getAssetPath();
        if (!data.fileStr) return;
        if (!data.filename)
        {
            return;
        }
        const buffer = Buffer.from(data.fileStr.split(",")[1], "base64");
        fs.writeFileSync(path.join(target, data.filename), buffer);
        return this.success(true, true);
    }

    async getAllProjectOps()
    {
        const currentUser = settings.getCurrentUser();
        const project = settings.getCurrentProject();

        let opDocs = [];

        if (!project)
        {
            return this.success(opDocs, true);
        }

        let projectOps = [];
        let projectNamespaces = [];
        let usedOpIds = [];
        // add all ops that are used in the toplevel of the project, save them as used
        project.ops.forEach((projectOp) =>
        {
            projectOps.push((opsUtil.getOpNameById(projectOp.opId)));
            usedOpIds.push(projectOp.opId);
        });

        // add all ops in any of the project op directory
        const otherDirsOps = doc.getOpDocsInProjectDirs(project).map((opDoc) => { return opDoc.name; });
        projectOps = projectOps.concat(otherDirsOps);

        // add all userops of the current user
        projectNamespaces.push(opsUtil.getUserNamespace(currentUser.username));

        // add all the patchops of the current patch
        const patchOps = opsUtil.getPatchOpsNamespaceForProject(project);
        if (patchOps) projectNamespaces.push(patchOps);

        // now we should have all the ops that are used in the project, walk subPatchOps
        // recursively to get their opdocs
        const subPatchOps = subPatchOpUtil.getOpsUsedInSubPatches(project);
        subPatchOps.forEach((subPatchOp) =>
        {
            const opName = opsUtil.getOpNameById(subPatchOp.opId);
            const nsName = opsUtil.getCollectionNamespace(opName);
            projectOps.push(opName);
            if (opsUtil.isCollection(nsName)) projectNamespaces.push(nsName);
            usedOpIds.push(subPatchOp.opId);
        });

        projectOps = helper.uniqueArray(projectOps);
        usedOpIds = helper.uniqueArray(usedOpIds);
        projectNamespaces = helper.uniqueArray(projectNamespaces);
        projectOps.forEach((opName) =>
        {
            let opDoc = doc.buildOpDocs(opName);
            if (opDoc)
            {
                if (!opDoc.name) opDoc.name = opName;
                opDocs.push(opDoc);
            }
        });

        // get opdocs for all the collected ops
        opDocs = opsUtil.addOpDocsForCollections(projectNamespaces, opDocs);
        opDocs.forEach((opDoc) =>
        {
            if (usedOpIds.includes(opDoc.id)) opDoc.usedInProject = true;
        });

        opsUtil.addPermissionsToOps(opDocs, currentUser, [], project);
        opsUtil.addVersionInfoToOps(opDocs);

        opDocs = doc.makeReadable(opDocs);
        return this.success(opDocs, true);
    }


    async getOpDocsAll()
    {
        const currentProject = settings.getCurrentProject();
        let opDocs = doc.getOpDocs(true, true);
        opDocs = opDocs.concat(doc.getOpDocsInProjectDirs(currentProject));

        const cleanDocs = doc.makeReadable(opDocs);
        opsUtil.addPermissionsToOps(cleanDocs, null);

        const extensions = doc.getAllExtensionDocs(true, true);
        const libs = projectsUtil.getAvailableLibs(currentProject);
        const coreLibs = projectsUtil.getCoreLibs();

        return this.success({
            "opDocs": cleanDocs,
            "extensions": extensions,
            "teamNamespaces": [],
            "libs": libs,
            "coreLibs": coreLibs
        }, true);
    }

    getOpDocs(data)
    {
        const opName = data.op.objName || opsUtil.getOpNameById(data.op.opId || data.op.id);
        if (!opName)
        {
            return {};
        }
        const result = {};
        result.opDocs = [];

        const opDoc = doc.getDocForOp(opName);
        result.content = "No docs yet...";

        const opDocs = [];
        if (opDoc) opDocs.push(opDoc);
        result.opDocs = doc.makeReadable(opDocs);
        result.opDocs = opsUtil.addPermissionsToOps(result.opDocs, null);
        const c = doc.getOpDocMd(opName);
        if (c) result.content = marked(c || "");
        return this.success(result, true);
    }

    saveOpCode(data)
    {
        const opName = opsUtil.getOpNameById(data.opname);
        const code = data.code;
        let returnedCode = code;

        // const format = opsUtil.validateAndFormatOpCode(code);
        // if (format.error)
        // {
        //     const {
        //         line,
        //         message
        //     } = format.message;
        //     this._log.info({
        //         line,
        //         message
        //     });
        //     return {
        //         "error": {
        //             line,
        //             message
        //         }
        //     };
        // }
        // const formatedCode = format.formatedCode;
        const formatedCode = code;
        if (data.format || opsUtil.isCoreOp(opName))
        {
            returnedCode = formatedCode;
        }
        returnedCode = opsUtil.updateOpCode(opName, settings.getCurrentUser(), returnedCode);
        doc.updateOpDocs(opName);

        return this.success({ "opFullCode": returnedCode }, true);
    }

    getOpCode(data)
    {
        const opName = opsUtil.getOpNameById(data.opId || data.opname);
        if (opsUtil.opExists(opName))
        {
            let code = opsUtil.getOpCode(opName);
            return this.success({
                "name": opName,
                "id": data.opId,
                "code": code
            }, true);
        }
        else
        {
            let code = "//empty file...";
            return this.success({
                "name": opName,
                "id": null,
                "code": code
            }, true);
        }
    }

    async getCollectionOpDocs(data)
    {
        let opDocs = [];
        const collectionName = data.name;
        const currentUser = settings.getCurrentUser();
        if (collectionName)
        {
            const opNames = opsUtil.getCollectionOpNames(collectionName, true);
            opDocs = opsUtil.addOpDocsForCollections(opNames, opDocs);
            opDocs = opsUtil.addVersionInfoToOps(opDocs);
            opDocs = opsUtil.addPermissionsToOps(opDocs, currentUser);
        }
        return this.success({ "opDocs": doc.makeReadable(opDocs) }, true);
    }


    getBuildInfo()
    {
        return this.success(settings.getBuildInfo(), true);
    }

    formatOpCode(data)
    {
        const code = data.code;
        if (code)
        {
            // const format = opsUtil.validateAndFormatOpCode(code);
            // if (format.error)
            // {
            //     const {
            //         line,
            //         message
            //     } = format.message;
            //     return {
            //         "error": {
            //             line,
            //             message
            //         }
            //     };
            // }
            // else
            // {
            //     return {
            //         "opFullCode": format.formatedCode,
            //         "success": true
            //     };
            // }

            return this.success({
                "opFullCode": code
            }, true);
        }
        else
        {
            return this.success({
                "opFullCode": ""
            }, true);
        }
    }

    saveUserSettings(data)
    {
        if (data && data.settings)
        {
            settings.setUserSettings(data.settings);
        }
    }

    checkProjectUpdated(data)
    {
        const project = settings.getCurrentProject();
        if (project)
        {
            return this.success({
                "updated": project.updated,
                "updatedByUser": project.updatedByUser,
                "buildInfo": project.buildInfo,
                "maintenance": false,
                "disallowSave": false
            }, true);
        }
        else
        {
            return this.success({
                "updated": "",
                "updatedByUser": "",
                "buildInfo": settings.getBuildInfo(),
                "maintenance": false,
                "disallowSave": false
            }, true);
        }
    }

    getChangelog(data)
    {
        const obj = {};
        obj.items = [];
        obj.ts = Date.now();
        return this.success(obj, true);
    }

    opAttachmentSave(data)
    {
        let opName = data.opname;
        if (opsUtil.isOpId(data.opname)) opName = opsUtil.getOpNameById(data.opname);
        const result = opsUtil.updateAttachment(opName, data.name, data.content, false);
        return this.success(result, true);
    }

    setIconSaved()
    {
        let title = electronApp.editorWindow.getTitle();
        const pos = title.lastIndexOf(" *");
        let newTitle = title;
        if (pos !== -1) newTitle = title.substring(0, pos);
        electronApp.setDocumentEdited(false);
        electronApp.editorWindow.setTitle(newTitle);
    }

    setIconUnsaved()
    {
        const title = electronApp.editorWindow.getTitle();
        electronApp.setDocumentEdited(true);
        electronApp.editorWindow.setTitle(title + " *");
    }

    saveScreenshot(data)
    {
        const currentProject = settings.getCurrentProject();
        if (!currentProject || !data || !data.screenshot)
        {
            return this.error("NO_PROJECT");
        }
        currentProject.screenshot = data.screenshot;
        projectsUtil.writeProjectToFile(settings.getCurrentProjectFile(), currentProject);
        return this.success({ "msg": "OK" }, true);
    }

    getFilelist(data)
    {
        let files;
        switch (data.source)
        {
        case "patch":
            files = filesUtil.getPatchFiles();
            break;
        case "lib":
            files = filesUtil.getLibraryFiles();
            break;
        default:
            files = [];
            break;
        }
        return this.success(files, true);
    }

    getFileDetails(data)
    {
        let filePath = helper.fileURLToPath(data.filename);
        const fileDb = filesUtil.getFileDb(filePath, settings.getCurrentProject(), settings.getCurrentUser());
        return this.success(filesUtil.getFileInfo(fileDb), true);
    }

    getLibraryFileInfo(data)
    {
        const fileName = filesUtil.realSanitizeFilename(data.filename);
        const fileCategory = filesUtil.realSanitizeFilename(data.fileCategory);

        const filePath = path.join(fileCategory, fileName);
        const libraryPath = cables.getAssetLibraryPath();
        const finalPath = path.join(libraryPath, filePath);

        if (!fs.existsSync(finalPath))
        {
            return this.success({}, true);
        }
        else
        {
            const infoFileName = finalPath + ".fileinfo.json";
            let filename = "";

            if (fs.existsSync(infoFileName))filename = infoFileName;

            if (filename === "")
            {
                return this.success({}, true);
            }
            else
            {
                const fileInfo = JSON.parse(fs.readFileSync(filename));
                return this.success(fileInfo, true);
            }
        }
    }

    checkOpName(data)
    {
        const opDocs = doc.getOpDocs(false, false);
        const newName = data.namespace + data.v;
        const sourceName = data.sourceName || null;
        const currentUser = settings.getCurrentUser();
        const result = this._getFullRenameResponse(opDocs, newName, sourceName, currentUser, true, false, data.opTargetDir);
        result.checkedName = newName;
        return this.success(result, true);
    }

    getRecentPatches()
    {
        const recents = settings.getRecentProjects();
        const result = [];
        for (let i = 0; i < recents.length; i++)
        {
            const recentProject = recents[i];
            let screenShot = recentProject.screenshot;
            if (!screenShot)
            {
                screenShot = projectsUtil.getScreenShotFileName(recentProject, "png");
                if (!fs.existsSync(screenShot)) screenShot = path.join(cables.getUiDistPath(), "/img/placeholder_dark.png");
            }
            result[i] = recentProject;
            result[i].thumbnail = screenShot;
        }
        return this.success(result.slice(0, 10), true);
    }

    opCreate(data)
    {
        let opName = data.opname;
        const currentUser = settings.getCurrentUser();
        const opDocDefaults = {
            "layout": data.layout,
            "libs": data.libs,
            "coreLibs": data.coreLibs
        };
        const result = opsUtil.createOp(opName, currentUser, data.code, opDocDefaults, data.attachments, data.opTargetDir);
        filesUtil.registerOpChangeListeners([opName]);

        return this.success(result, true);
    }

    opUpdate(data)
    {
        const opName = data.opname;
        const currentUser = settings.getCurrentUser();
        return this.success({ "data": opsUtil.updateOp(currentUser, opName, data.update, { "formatCode": data.formatCode }) }, true);
    }

    opSaveLayout(data)
    {
        const layout = data.layout;
        const opName = opsUtil.getOpNameById(data.opname) || layout.name;
        return this.success(opsUtil.saveLayout(opName, layout), true);
    }

    opClone(data)
    {
        const newName = data.name;
        const oldName = opsUtil.getOpNameById(data.opname) || data.opname;
        const currentUser = settings.getCurrentUser();
        return this.success(opsUtil.cloneOp(oldName, newName, currentUser, data.opTargetDir), true);
    }

    async installProjectDependencies()
    {
        const currentProjectDir = settings.getCurrentProjectDir();
        const opsDir = cables.getProjectOpsPath();

        let toInstall = [];
        if (opsDir && fs.existsSync(opsDir))
        {
            const packageFiles = helper.getFilesRecursive(opsDir, "package.json");
            const fileNames = Object.keys(packageFiles).filter((packageFile) => { return !packageFile.includes("node_modules"); });

            let __dirname = helper.fileURLToPath(new URL(".", import.meta.url));
            __dirname = __dirname.includes(".asar") ? __dirname.replace(".asar", ".asar.unpacked") : __dirname;
            const npm = path.join(__dirname, "../../node_modules/npm/bin/npm-cli.js");
            fileNames.forEach((packageFile) =>
            {
                const fileContents = packageFiles[packageFile];
                const fileJson = JSON.parse(fileContents);
                let deps = fileJson.dependencies || {};
                let devDeps = fileJson.devDependencies || {};
                const allDeps = { ...devDeps, ...deps };
                Object.keys(allDeps).forEach((lib) =>
                {
                    if (lib)
                    {
                        const ver = allDeps[lib];
                        if (ver)
                        {
                            const semVer = lib + "@" + ver;
                            toInstall.push(semVer);
                        }
                    }
                });
            });
            toInstall = helper.uniqueArray(toInstall);

            if (toInstall.length > 0)
            {
                try
                {
                    const out = execaSync(npm, ["install", toInstall, "--legacy-peer-deps"], { "cwd": currentProjectDir });
                    out.packages = toInstall;
                    return this.success(out);
                }
                catch (e)
                {
                    return { "stderr": e, "packages": toInstall };
                }
            }
        }
        return this.success({ "stdout": "nothing to install", "packages": toInstall });
    }

    async openDir(options)
    {
        if (options && options.dir)
        {
            shell.openPath(options.dir);
            return this.success({}, true);
        }
    }

    async openOpDir(options)
    {
        const opName = opsUtil.getOpNameById(options.opId) || options.opName;
        if (!opName) return;
        const opDir = opsUtil.getOpAbsoluteFileName(opName);
        if (opDir)
        {
            shell.showItemInFolder(opDir);
            return this.success({}, true);
        }
    }

    async openProjectDir()
    {
        const projectFile = settings.getCurrentProjectFile();
        if (projectFile)
        {
            shell.showItemInFolder(projectFile);
            return this.success({});
        }
    }

    async openAssetDir(data)
    {
        let assetPath = helper.fileURLToPath(data.url, true);
        if (fs.existsSync(assetPath))
        {
            const stats = fs.statSync(assetPath);
            if (stats.isDirectory())
            {
                shell.openPath(assetPath);
                return this.success({});
            }
            else
            {
                shell.showItemInFolder(assetPath);
                return this.success({});
            }
        }
        else
        {
            shell.openPath(cables.getAssetPath());
            return this.success({});
        }
    }

    async selectFile(data)
    {
        if (data && data.url)
        {
            let assetUrl = helper.fileURLToPath(data.url, true);
            let filter = ["*"];
            if (data.filter)
            {
                filter = filesUtil.FILETYPES[data.filter] || ["*"];
            }
            const pickedFileUrl = await electronApp.pickFileDialog(assetUrl, true, filter);
            return this.success(pickedFileUrl, true);
        }
        else
        {
            return this.error("NO_FILE_SELECTED");
        }
    }


    checkNumAssetPatches()
    {
        return this.success({ "assets": [], "countPatches": 0, "countOps": 0 }, true);
    }

    async saveProjectAs()
    {
        const projectFile = await electronApp.saveProjectFileDialog();
        if (!projectFile)
        {
            logger.info("no project dir chosen");
            return this.error("UNKNOWN_PROJECT");
        }

        let collaborators = [];
        let usersReadOnly = [];

        const currentUser = settings.getCurrentUser();
        const origProject = settings.getCurrentProject();
        origProject._id = helper.generateRandomId();
        origProject.name = path.basename(projectFile);
        origProject.summary = origProject.summary || {};
        origProject.summary.title = origProject.name;
        origProject.userId = currentUser._id;
        origProject.cachedUsername = currentUser.username;
        origProject.created = Date.now();
        origProject.cloneOf = origProject._id;
        origProject.updated = Date.now();
        origProject.users = collaborators;
        origProject.usersReadOnly = usersReadOnly;
        origProject.visibility = "private";
        origProject.shortId = helper.generateShortId(origProject._id, Date.now());
        projectsUtil.writeProjectToFile(projectFile, origProject);
        this.loadProject(projectFile);
        electronApp.reload();
        return this.success(origProject, true);
    }

    async gotoPatch(data)
    {
        let project = null;
        let projectFile = null;
        if (data && data.id)
        {
            projectFile = settings.getRecentProjectFile(data.id);
            if (projectFile) project = settings.getProjectFromFile(projectFile);
        }
        if (project && projectFile)
        {
            electronApp.openPatch(projectFile);
            return this.success(true, true);
        }
        else
        {
            const file = await electronApp.pickProjectFileDialog();
            return this.success({ "projectFile": file });
        }
    }

    updateFile(data)
    {
        this._log.info("file edit...");
        if (!data || !data.fileName)
        {
            return this.error("UNKNOWN_FILE");
        }


        const project = settings.getCurrentProject();
        const newPath = path.join(projectsUtil.getAssetPath(project._id), "/");
        if (!fs.existsSync(newPath)) mkdirp.sync(newPath);

        const sanitizedFileName = filesUtil.realSanitizeFilename(data.fileName);

        try
        {
            if (fs.existsSync(newPath + sanitizedFileName))
            {
                this._log.info("delete old file ", sanitizedFileName);
                fs.unlinkSync(newPath + sanitizedFileName);
            }
        }
        catch (e) {}

        this._log.info("edit file", newPath + sanitizedFileName);

        fs.writeFileSync(newPath + sanitizedFileName, data.content);
        return this.success({ "filename": sanitizedFileName }, true);
    }

    async setProjectUpdated()
    {
        const now = Date.now();
        const project = settings.getCurrentProject();
        const projectFile = settings.getCurrentProjectFile();
        project.updated = now;
        if (projectFile)
        {
            projectsUtil.writeProjectToFile(projectFile, project);
        }
        return this.success(project);
    }

    getOpTargetDirs()
    {
        const dirs = opsUtil.getOpTargetDirs(settings.getCurrentProject());
        const dirInfos = [];
        dirs.forEach((dir) =>
        {
            dirInfos.push({
                "dir": dir,
            });
        });
        return this.success(dirInfos);
    }

    async addProjectOpDir()
    {
        const project = settings.getCurrentProject();
        if (!project) return;
        const opDir = await electronApp.pickOpDirDialog();
        if (opDir)
        {
            if (!project.dirs) project.dirs = {};
            if (!project.dirs.ops) project.dirs.ops = [];
            project.dirs.ops.unshift(opDir);
            return this.success(projectsUtil.getProjectOpDirs(project, false), true);
        }
        else
        {
            logger.info("no project dir chosen");
            return this.error("no project dir chosen", []);
        }
    }

    setProjectName(options)
    {
        const oldFile = settings.getCurrentProjectFile();
        let project = settings.getCurrentProject();
        project.name = options.name;
        const newFile = path.join(settings.getCurrentProjectDir(), projectsUtil.getProjectFileName(project));
        project.name = path.basename(newFile);
        project.summary = project.summary || {};
        project.summary.title = project.name;
        fs.renameSync(oldFile, newFile);
        settings.replaceInRecentProjects(oldFile, newFile);
        projectsUtil.writeProjectToFile(newFile, project);
        this.loadProject(newFile);
        electronApp.updateTitle();
        return this.success({ "name": project.name });
    }

    cycleFullscreen()
    {
        electronApp.cycleFullscreen();
    }

    collectAssets()
    {
        const currentProject = settings.getCurrentProject();
        const assetFilenames = projectsUtil.getUsedAssetFilenames(currentProject, true);
        const oldNew = {};
        const projectAssetPath = cables.getAssetPath();
        assetFilenames.forEach((oldFile) =>
        {
            const oldUrl = helper.pathToFileURL(oldFile);
            if (!helper.isLocalAssetPath(oldFile) && !oldNew.hasOwnProperty(oldUrl) && fs.existsSync(oldFile))
            {
                const baseName = path.basename(oldFile);
                const newName = this._findNewAssetFilename(projectAssetPath, baseName);
                const newLocation = path.join(projectAssetPath, newName);
                fs.copyFileSync(oldFile, newLocation);
                oldNew[oldUrl] = path.join(projectsUtil.getAssetPathUrl(currentProject), newName);
            }
        });
        this._log.debug("collectAssets", oldNew);
        return this.success(oldNew);
    }

    collectOps()
    {
        const currentProject = settings.getCurrentProject();
        const movedOps = {};
        const allOpNames = [];
        if (currentProject && currentProject.ops)
        {
            currentProject.ops.forEach((op) =>
            {
                const opName = opsUtil.getOpNameById(op.opId);
                allOpNames.push(opName);
                if (!movedOps.hasOwnProperty(opName))
                {
                    const opPath = opsUtil.getOpAbsolutePath(opName);
                    if (!opPath.startsWith(cables.getOpsPath()))
                    {
                        const targetPath = opsUtil.getOpTargetDir(opName, true);
                        const newOpLocation = path.join(cables.getProjectOpsPath(true), targetPath);
                        if (opPath !== newOpLocation)
                        {
                            fs.cpSync(opPath, newOpLocation, { "recursive": true });
                            movedOps[opName] = newOpLocation;
                        }
                    }
                }
            });
        }
        filesUtil.registerOpChangeListeners(allOpNames, true);
        return this.success(movedOps);
    }

    loadProject(patchPath, newProject)
    {
        const project = settings.loadProject(patchPath, newProject);
        electronApp.updateTitle();
        if (project) doc.getOpDocsInProjectDirs(project);
    }

    success(data, raw = false)
    {
        if (raw)
        {
            if (data && typeof data === "object") data.success = true;
            return data;
        }
        else
        {
            return { "success": true, "data": data };
        }
    }

    error(msg, data)
    {
        return { "error": true, "msg": msg, "data": data };
    }

    _getFullRenameResponse(opDocs, newName, oldName, currentUser, ignoreVersionGap = false, fromRename = false, targetDir = false)
    {
        let opNamespace = opsUtil.getNamespace(newName);
        let availableNamespaces = ["Ops.Standalone.", "Ops."];
        availableNamespaces = helper.uniqueArray(availableNamespaces);
        if (opNamespace && !opsUtil.isPatchOp(opNamespace) && !availableNamespaces.includes(opNamespace)) availableNamespaces.unshift(opNamespace);

        let removeOld = newName && !(opsUtil.isExtensionOp(newName) && opsUtil.isCoreOp(newName));
        const result = {
            "namespaces": availableNamespaces,
            "problems": [],
            "consequences": [],
            "action": removeOld ? "Rename" : "Copy"
        };

        if (!newName)
        {
            result.problems.push("No name for new op given.");
            return result;
        }

        const problems = opsUtil.getOpRenameProblems(newName, oldName, currentUser, [], null, null, [], true, targetDir);
        const hints = {};
        const consequences = opsUtil.getOpRenameConsequences(newName, oldName, targetDir);

        const newNamespace = opsUtil.getNamespace(newName);
        const existingNamespace = opsUtil.namespaceExists(newNamespace, opDocs);
        if (!existingNamespace)
        {
            hints.new_namespace = "Renaming will create a new namespace " + newNamespace;
        }

        let newOpDocs = opDocs;
        if (!opsUtil.isCoreOp(newName)) newOpDocs = doc.getCollectionOpDocs(newName, currentUser);

        const nextOpName = opsUtil.getNextVersionOpName(newName, newOpDocs);
        const nextShort = opsUtil.getOpShortName(nextOpName);
        let nextVersion = null;
        let suggestVersion = false;

        if (problems.target_exists)
        {
            suggestVersion = true;
        }

        if (!ignoreVersionGap)
        {
            const wantedVersion = opsUtil.getVersionFromOpName(newName);
            const currentHighest = opsUtil.getHighestVersionNumber(newName, newOpDocs);

            const versionTolerance = currentHighest ? 1 : 2;
            if ((wantedVersion - versionTolerance) > currentHighest)
            {
                hints.version_gap = "Gap in version numbers!";
                suggestVersion = true;
            }
        }

        if (problems.illegal_ops || problems.illegal_references)
        {
            suggestVersion = false;
        }

        if (!fromRename && oldName)
        {
            const hierarchyProblem = opsUtil.getNamespaceHierarchyProblem(oldName, newName);
            if (hierarchyProblem)
            {
                problems.bad_op_hierarchy = hierarchyProblem;
                suggestVersion = false;
            }
        }

        if (suggestVersion)
        {
            const text = "Try creating a new version <a class='button-small versionSuggestion' data-short-name='" + nextShort + "'>" + nextOpName + "</a>";
            nextVersion = {
                "fullName": nextOpName,
                "namespace": opsUtil.getNamespace(nextOpName),
                "shortName": nextShort
            };
            if (problems.target_exists)
            {
                problems.version_suggestion = text;
            }
            else
            {
                hints.version_suggestion = text;
            }
        }

        result.problems = Object.values(problems);
        result.hints = Object.values(hints);
        result.consequences = Object.values(consequences);
        if (nextVersion) result.nextVersion = nextVersion;
        return result;
    }

    _findNewAssetFilename(targetDir, fileName)
    {
        let fileInfo = path.parse(fileName);
        let newName = fileName;
        let counter = 1;
        while (fs.existsSync(path.join(targetDir, newName)))
        {
            newName = path.format({ "name": fileInfo.name + "_" + counter, "ext": fileInfo.ext });
            counter++;
        }
        return newName;
    }
}

export default new ElectronApi();
