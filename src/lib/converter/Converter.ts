import {ProjectReflection} from "../models/reflections/ProjectReflection";
import {PluginHost} from "../PluginHost";
import {Reflection} from "../models/Reflection";
import {IApplication} from "../Application";
import {Context} from "./Context";
import {ConverterPlugin} from "./ConverterPlugin";
import {IParameter, ParameterType} from "../Options";
import {visit} from "./converters/convertNode";
import * as Path from "path";


export enum SourceFileMode {
    File, Modules
}


/**
 * Result structure of the [[Converter.convert]] method.
 */
export interface IConverterResult
{
    /**
     * An array containing all errors generated by the TypeScript compiler.
     */
    errors:ts.Diagnostic[];

    /**
     * The resulting project reflection.
     */
    project:ProjectReflection;
}


/**
 * Event callback definition for generic converter events.
 *
 * @see [[Converter.EVENT_BEGIN]]
 * @see [[Converter.EVENT_END]]
 * @see [[Converter.EVENT_RESOLVE_BEGIN]]
 * @see [[Converter.EVENT_RESOLVE_END]]
 */
interface IConverterCallback
{
    /**
     * @param context  The context object describing the current state the converter is in.
     */
    (context:Context):void;
}


/**
 * Event callback definition for events triggered by factories.
 *
 * @see [[Converter.EVENT_FILE_BEGIN]]
 * @see [[Converter.EVENT_CREATE_DECLARATION]]
 * @see [[Converter.EVENT_CREATE_SIGNATURE]]
 * @see [[Converter.EVENT_CREATE_PARAMETER]]
 * @see [[Converter.EVENT_CREATE_TYPE_PARAMETER]]
 * @see [[Converter.EVENT_FUNCTION_IMPLEMENTATION]]
 */
interface IConverterNodeCallback
{
    /**
     * @param context  The context object describing the current state the converter is in.
     * @param reflection  The reflection that is currently processed.
     * @param node  The node that is currently processed if available.
     */
    (context:Context, reflection:Reflection, node?:ts.Node):void;
}


/**
 * Event callback definition for events during the resolving phase.
 *
 * @see [[Converter.EVENT_RESOLVE]]
 */
interface IConverterResolveCallback
{
    /**
     * @param context  The context object describing the current state the converter is in.
     * @param reflection  The reflection that is currently resolved.
     */
    (context:Context, reflection:Reflection):void;
}


/**
 * Compiles source files using TypeScript and converts compiler symbols to reflections.
 */
export class Converter extends PluginHost<ConverterPlugin> implements ts.CompilerHost
{
    /**
     * The host application of this converter instance.
     */
    application:IApplication;

    /**
     * The full path of the current directory. Result cache of [[getCurrentDirectory]].
     */
    private currentDirectory:string;

    /**
     * Return code of ts.sys.readFile when the file encoding is unsupported.
     */
    static ERROR_UNSUPPORTED_FILE_ENCODING = -2147024809;


    /**
     * General events
     */

    /**
     * Triggered when the converter begins converting a project.
     * The listener should implement [[IConverterCallback]].
     * @event
     */
    static EVENT_BEGIN:string = 'begin';

    /**
     * Triggered when the converter has finished converting a project.
     * The listener should implement [[IConverterCallback]].
     * @event
     */
    static EVENT_END:string = 'end';


    /**
     * Factory events
     */

    /**
     * Triggered when the converter begins converting a source file.
     * The listener should implement [[IConverterNodeCallback]].
     * @event
     */
    static EVENT_FILE_BEGIN:string = 'fileBegin';

    /**
     * Triggered when the converter has created a declaration reflection.
     * The listener should implement [[IConverterNodeCallback]].
     * @event
     */
    static EVENT_CREATE_DECLARATION:string = 'createDeclaration';

    /**
     * Triggered when the converter has created a signature reflection.
     * The listener should implement [[IConverterNodeCallback]].
     * @event
     */
    static EVENT_CREATE_SIGNATURE:string = 'createSignature';

    /**
     * Triggered when the converter has created a parameter reflection.
     * The listener should implement [[IConverterNodeCallback]].
     * @event
     */
    static EVENT_CREATE_PARAMETER:string = 'createParameter';

    /**
     * Triggered when the converter has created a type parameter reflection.
     * The listener should implement [[IConverterNodeCallback]].
     * @event
     */
    static EVENT_CREATE_TYPE_PARAMETER:string = 'createTypeParameter';

    /**
     * Triggered when the converter has found a function implementation.
     * The listener should implement [[IConverterNodeCallback]].
     * @event
     */
    static EVENT_FUNCTION_IMPLEMENTATION:string = 'functionImplementation';


    /**
     * Resolve events
     */

    /**
     * Triggered when the converter begins resolving a project.
     * The listener should implement [[IConverterCallback]].
     * @event
     */
    static EVENT_RESOLVE_BEGIN:string = 'resolveBegin';

    /**
     * Triggered when the converter resolves a reflection.
     * The listener should implement [[IConverterResolveCallback]].
     * @event
     */
    static EVENT_RESOLVE:string = 'resolveReflection';

    /**
     * Triggered when the converter has finished resolving a project.
     * The listener should implement [[IConverterCallback]].
     * @event
     */
    static EVENT_RESOLVE_END:string = 'resolveEnd';



    /**
     * Create a new Converter instance.
     *
     * @param application  The application instance this converter relies on. The application
     *   must expose the settings that should be used and serves as a global logging endpoint.
     */
    constructor(application:IApplication) {
        super();
        this.application = application;

        Converter.loadPlugins(this);
    }


    /**
     * Return a list of parameters introduced by this component.
     *
     * @returns A list of parameter definitions introduced by this component.
     */
    getParameters():IParameter[] {
        return super.getParameters().concat(<IParameter[]>[{
            name: "name",
            help: 'Set the name of the project that will be used in the header of the template.'
        },{
            name: "mode",
            help: "Specifies the output mode the project is used to be compiled with: 'file' or 'modules'",
            type: ParameterType.Map,
            map: {
                'file': SourceFileMode.File,
                'modules': SourceFileMode.Modules
            },
            defaultValue: SourceFileMode.Modules
        },{
            name: "externalPattern",
            key: 'Define a pattern for files that should be considered being external.'
        },{
            name: "includeDeclarations",
            help: 'Turn on parsing of .d.ts declaration files.',
            type: ParameterType.Boolean
        },{
            name: "excludeExternals",
            help: 'Prevent externally resolved TypeScript files from being documented.',
            type: ParameterType.Boolean
        },{
            name: "excludeNotExported",
            help: 'Prevent symbols that are not exported from being documented.',
            type: ParameterType.Boolean
        }]);
    }


    /**
     * Compile the given source files and create a project reflection for them.
     *
     * @param fileNames  Array of the file names that should be compiled.
     */
    convert(fileNames:string[]):IConverterResult {
        if (this.application.options.verbose) {
            this.application.logger.verbose('\n\x1b[32mStarting conversion\x1b[0m\n\nInput files:');
            for (var i = 0, c = fileNames.length; i < c; i++) {
                this.application.logger.verbose(' - ' + fileNames[i]);
            }
            this.application.logger.verbose('\n');
        }

        for (var i = 0, c = fileNames.length; i < c; i++) {
            fileNames[i] = ts.normalizePath(ts.normalizeSlashes(fileNames[i]));
        }

        var program = ts.createProgram(fileNames, this.application.compilerOptions, this);
        var checker = program.getTypeChecker();
        var context = new Context(this, fileNames, checker, program);

        this.dispatch(Converter.EVENT_BEGIN, context);

        var errors = this.compile(context);
        var project = this.resolve(context);

        this.dispatch(Converter.EVENT_END, context);

        if (this.application.options.verbose) {
            this.application.logger.verbose('\n\x1b[32mFinished conversion\x1b[0m\n');
        }

        return {
            errors: errors,
            project: project
        }
    }


    /**
     * Compile the files within the given context and convert the compiler symbols to reflections.
     *
     * @param context  The context object describing the current state the converter is in.
     * @returns An array containing all errors generated by the TypeScript compiler.
     */
    private compile(context:Context):ts.Diagnostic[] {
        var program = context.program;

        program.getSourceFiles().forEach((sourceFile) => {
            visit(context, sourceFile);
        });

        // First get any syntactic errors.
        var diagnostics = program.getSyntacticDiagnostics();
        if (diagnostics.length === 0) {
            diagnostics = program.getGlobalDiagnostics();
            if (diagnostics.length === 0) {
                return program.getSemanticDiagnostics();
            } else {
                return diagnostics;
            }
        } else {
            return diagnostics;
        }
    }


    /**
     * Resolve the project within the given context.
     *
     * @param context  The context object describing the current state the converter is in.
     * @returns The final project reflection.
     */
    private resolve(context:Context):ProjectReflection {
        this.dispatch(Converter.EVENT_RESOLVE_BEGIN, context);
        var project = context.project;

        for (var id in project.reflections) {
            if (!project.reflections.hasOwnProperty(id)) continue;
            if (this.application.options.verbose) {
                this.application.logger.verbose('Resolving %s', project.reflections[id].getFullName());
            }

            this.dispatch(Converter.EVENT_RESOLVE, context, project.reflections[id]);
        }

        this.dispatch(Converter.EVENT_RESOLVE_END, context);
        return project;
    }


    /**
     * Return the basename of the default library that should be used.
     *
     * @returns The basename of the default library.
     */
    getDefaultLib():string {
        var target = this.application.compilerOptions.target;
        return target == ts.ScriptTarget.ES6 ? 'lib.es6.d.ts' : 'lib.d.ts';
    }



    /**
     * CompilerHost implementation
     */


    /**
     * Return an instance of ts.SourceFile representing the given file.
     *
     * Implementation of ts.CompilerHost.getSourceFile()
     *
     * @param filename  The path and name of the file that should be loaded.
     * @param languageVersion  The script target the file should be interpreted with.
     * @param onError  A callback that will be invoked if an error occurs.
     * @returns An instance of ts.SourceFile representing the given file.
     */
    getSourceFile(filename:string, languageVersion:ts.ScriptTarget, onError?: (message: string) => void):ts.SourceFile {
        try {
            var text = ts.sys.readFile(filename, this.application.compilerOptions.charset);
        } catch (e) {
            if (onError) {
                onError(e.number === Converter.ERROR_UNSUPPORTED_FILE_ENCODING ? 'Unsupported file encoding' : e.message);
            }
            text = "";
        }

        return text !== undefined ? ts.createSourceFile(filename, text, languageVersion) : undefined;
    }


    /**
     * Return the full path of the default library that should be used.
     *
     * Implementation of ts.CompilerHost.getDefaultLibFilename()
     *
     * @returns The full path of the default library.
     */
    getDefaultLibFileName(options: ts.CompilerOptions):string {
        var lib = this.getDefaultLib();
        var path = ts.getDirectoryPath(ts.normalizePath(td.tsPath));
        return Path.join(path, 'bin', lib);
    }


    /**
     * Return the full path of the current directory.
     *
     * Implementation of ts.CompilerHost.getCurrentDirectory()
     *
     * @returns The full path of the current directory.
     */
    getCurrentDirectory():string {
        return this.currentDirectory || (this.currentDirectory = ts.sys.getCurrentDirectory());
    }


    /**
     * Return whether file names are case sensitive on the current platform or not.
     *
     * Implementation of ts.CompilerHost.useCaseSensitiveFileNames()
     *
     * @returns TRUE if file names are case sensitive on the current platform, FALSE otherwise.
     */
    useCaseSensitiveFileNames():boolean {
        return ts.sys.useCaseSensitiveFileNames;
    }


    /**
     * Return the canonical file name of the given file.
     *
     * Implementation of ts.CompilerHost.getCanonicalFileName()
     *
     * @param fileName  The file name whose canonical variant should be resolved.
     * @returns The canonical file name of the given file.
     */
    getCanonicalFileName(fileName:string):string {
        return ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase();
    }


    /**
     * Return the new line char sequence of the current platform.
     *
     * Implementation of ts.CompilerHost.getNewLine()
     *
     * @returns The new line char sequence of the current platform.
     */
    getNewLine():string {
        return ts.sys.newLine;
    }


    /**
     * Write a compiled javascript file to disc.
     *
     * As TypeDoc will not emit compiled javascript files this is a null operation.
     *
     * Implementation of ts.CompilerHost.writeFile()
     *
     * @param fileName  The name of the file that should be written.
     * @param data  The contents of the file.
     * @param writeByteOrderMark  Whether the UTF-8 BOM should be written or not.
     * @param onError  A callback that will be invoked if an error occurs.
     */
    writeFile(fileName:string, data:string, writeByteOrderMark:boolean, onError?:(message: string) => void) { }
}
