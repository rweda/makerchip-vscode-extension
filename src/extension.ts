// The module 'vscode' contains the VS Code extensibility API
// Import the necessary extensibility types to use in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import axios from "axios";
import * as child_process from "child_process";
import * as util from "util";
import { TLVerilogSemanticTokensProvider, legend } from './semanticTokenProvider';


//@ts-ignore
class SandPiperButton implements vscode.StatusBarItem {
  private statusBarItem: vscode.StatusBarItem;
  private activeEditor: vscode.TextEditor | undefined;

  alignment: vscode.StatusBarAlignment;
  priority: number;
  text: string;
  tooltip: string;
  color: string;
  command: string | undefined;

  constructor(
    alignment: vscode.StatusBarAlignment = vscode.StatusBarAlignment.Left,
    priority: number = 0
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(alignment, priority);
    this.statusBarItem.command = "extension.sandpiperSaas";
    this.statusBarItem.text = "$(rocket) SandPiper";
    this.statusBarItem.tooltip = "Compile TL-Verilog using SandPiper SaaS";
    this.text = "$(rocket) SandPiper";
    this.tooltip = "Compile TL-Verilog using SandPiper SaaS";
    this.alignment = alignment;
    this.priority = priority;
    this.activeEditor = vscode.window.activeTextEditor;
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      this.activeEditor = editor;
      this.updateVisibility();
    });
  }

  show() {
    this.statusBarItem.show();
  }

  hide() {
    this.statusBarItem.hide();
  }

  dispose() {
    this.statusBarItem.dispose();
  }
  private updateVisibility() {
    if (this.activeEditor && this.activeEditor.document.languageId === "tlverilog") {
      this.show();
    } else {
      this.hide();
    }
  }
}

//@ts-ignore
class SvgButton implements vscode.StatusBarItem {
  private statusBarItem: vscode.StatusBarItem;
  private activeEditor: vscode.TextEditor | undefined;

  alignment: vscode.StatusBarAlignment;
  priority: number;
  text: string;
  tooltip: string;
  color: string;
  command: string | undefined;

  constructor(
    alignment: vscode.StatusBarAlignment = vscode.StatusBarAlignment.Left,
    priority: number = 1
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(alignment, priority);
    this.statusBarItem.command = "extension.showSvg";
    this.statusBarItem.text = "$(file-media) SVG";
    this.statusBarItem.tooltip = "Generate and view TL-Verilog SVG diagram";
    this.text = "$(file-media) SVG";
    this.tooltip = "Generate and view TL-Verilog SVG diagram";
    this.alignment = alignment;
    this.priority = priority;
    this.activeEditor = vscode.window.activeTextEditor;
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      this.activeEditor = editor;
      this.updateVisibility();
    });
  }

  show() {
    this.statusBarItem.show();
  }

  hide() {
    this.statusBarItem.hide();
  }

  dispose() {
    this.statusBarItem.dispose();
  }
  private updateVisibility() {
    if (this.activeEditor && this.activeEditor.document.languageId === "tlverilog") {
      this.show();
    } else {
      this.hide();
    }
  }
}


//@ts-ignore
class NavTlvButton implements vscode.StatusBarItem {
  private statusBarItem: vscode.StatusBarItem;
  private activeEditor: vscode.TextEditor | undefined;

  alignment: vscode.StatusBarAlignment;
  priority: number;
  text: string;
  tooltip: string;
  color: string;
  command: string | undefined;

  constructor(
    alignment: vscode.StatusBarAlignment = vscode.StatusBarAlignment.Left,
    priority: number = 3
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(alignment, priority);
    this.statusBarItem.command = "extension.showNavTlv";
    this.statusBarItem.text = "$(list-tree) Nav TLV";
    this.statusBarItem.tooltip = "Open Nav TLV Viewer";
    this.text = "$(list-tree) Nav TLV";
    this.tooltip = "Open Nav TLV Viewer";
    this.alignment = alignment;
    this.priority = priority;
    this.activeEditor = vscode.window.activeTextEditor;
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      this.activeEditor = editor;
      this.updateVisibility();
    });
  }

  show() {
    this.statusBarItem.show();
  }

  hide() {
    this.statusBarItem.hide();
  }

  dispose() {
    this.statusBarItem.dispose();
  }
  private updateVisibility() {
    if (this.activeEditor && this.activeEditor.document.languageId === "tlverilog") {
      this.show();
    } else {
      this.hide();
    }
  }
}


// @ts-ignore
class WaveformButton implements vscode.StatusBarItem {
  private statusBarItem: vscode.StatusBarItem;

  alignment: vscode.StatusBarAlignment;
  priority: number;
  text: string;
  tooltip: string;
  color: string;
  command: string | undefined;

  constructor(
    alignment: vscode.StatusBarAlignment = vscode.StatusBarAlignment.Left,
    priority: number = 2
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(alignment, priority);
    this.statusBarItem.command = "extension.runVerilator";
    this.statusBarItem.text = "$(pulse) Waveform";
    this.statusBarItem.tooltip = "Generate and view waveform";
    this.text = "$(pulse) Waveform";
    this.tooltip = "Generate and view waveform";
    this.alignment = alignment;
    this.priority = priority;
  }

  show() {
    this.statusBarItem.show();
  }

  hide() {
    this.statusBarItem.hide();
  }

  dispose() {
    this.statusBarItem.dispose();
  }
}

const exec = util.promisify(child_process.exec);

async function generateAndViewWaveform(filePath: string) {
  const outputDirectory = path.dirname(filePath);
  const fileName = path.basename(filePath, path.extname(filePath));
  const vcdFilePath = path.join(outputDirectory, `vlt_dump.vcd`);

  try {
    await setupSimulationFiles(outputDirectory);
    await compileWithVerilator(filePath, outputDirectory);
    await runSimulation(outputDirectory);

    // const document = await vscode.workspace.openTextDocument(vcdFilePath);
    // await vscode.window.showTextDocument(document, vscode.ViewColumn.Two);


    const isGTKWaveInstalled = await checkGTKWaveInstallation();
    if (!isGTKWaveInstalled) {
      vscode.window.showErrorMessage(
        'GTKWave is not installed. Please install GTKWave to view waveforms.'
      );
      return;
    }


    await launchGTKWave(vcdFilePath);

    vscode.window.showInformationMessage(
      `Waveform opened in GTKWave: ${vcdFilePath}`
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to generate waveform: ${error.message}`
    );
  }
}

// This method is called when your extension is activated. Activation is
// controlled by the activation events defined in package.json.
export function activate(context: vscode.ExtensionContext) {
    console.log('[TLV] activate() called — registering providers');
    // System Verilog Hover Provider
    context.subscriptions.push(
        vscode.languages.registerHoverProvider('tlverilog',
            new tlverilogHoverProvider()
        )
    );

    // instantiate system verilog module
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.tlverilog.instantiateModule',
            instantiateModuleInteract
        )
    );

    // console.log('Registering semantic token provider...');
    context.subscriptions.push(
        vscode.languages.registerDocumentSemanticTokensProvider(
            { language: 'tlverilog' },
            new TLVerilogSemanticTokensProvider(),
            legend
        )
    );
    // console.log('Semantic token provider registered!');
  
  const editor = vscode.window.activeTextEditor;
  const sandpiperButton = new SandPiperButton();
  sandpiperButton.show();
  const svgButton = new SvgButton();
  svgButton.show();
  const navTlvButton = new NavTlvButton();
  navTlvButton.show();
  const waveformButton = new WaveformButton();
  waveformButton.show();
  const conversionCommand = vscode.commands.registerCommand(
    "extension.sandpiperSaas",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const document = editor.document;
        if (document.languageId === "tlverilog") {
          const tlvCode = document.getText();
          const inputFilePath = document.fileName;
          try {
            await compileTLVerilogWithSandPiper(tlvCode, inputFilePath);
          } catch (error) {
            vscode.window.showErrorMessage(
              `SandPiper SaaS compilation failed: ${error.message}`
            );
          }
        } else {
          vscode.window.showInformationMessage(
            "The active file is not a TL-Verilog file."
          );
        }
      } else {
        vscode.window.showInformationMessage("No active text editor found.");
      }
    }
  );
  context.subscriptions.push(conversionCommand);

  const showSvgCommand = vscode.commands.registerCommand(
    "extension.showSvg",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const document = editor.document;
        if (document.languageId === "tlverilog") {
          const tlvCode = document.getText();
          const inputFilePath = document.fileName;
          try {
            const svgFilePath = await generateSvgFile(tlvCode, inputFilePath);
            showSvgInWebview(svgFilePath);
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to generate SVG: ${error.message}`
            );
          }
        } else {
          vscode.window.showInformationMessage(
            "The active file is not a TL-Verilog file."
          );
        }
      } else {
        vscode.window.showInformationMessage("No active text editor found.");
      }
    }
  );
  context.subscriptions.push(showSvgCommand);

  const showNavTlvCommand = vscode.commands.registerCommand(
    "extension.showNavTlv",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const document = editor.document;
        if (document.languageId === "tlverilog") {
          const tlvCode = document.getText();
          const inputFilePath = document.fileName;
          try {
            const navTlvHtml = await generateNavTlvHtml(tlvCode, inputFilePath);
            showNavTlvInWebview(navTlvHtml);
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to generate Nav TLV: ${error.message}`
            );
          }
        } else {
          vscode.window.showInformationMessage(
            "The active file is not a TL-Verilog file."
          );
        }
      } else {
        vscode.window.showInformationMessage("No active text editor found.");
      }
    }
  );
  context.subscriptions.push(showNavTlvCommand);

  const generateWaveformCommand = vscode.commands.registerCommand(
    "extension.runVerilator",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const document = editor.document;
        if (
          document.languageId === "systemverilog" ||
          document.languageId === "verilog"
        ) {
          try {
            await generateAndViewWaveform(document.uri.fsPath);
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to generate waveform: ${error.message}`
            );
          }
        } else {
          vscode.window.showInformationMessage(
            "The active file is not a SystemVerilog or Verilog file."
          );
        }
      } else {
        vscode.window.showInformationMessage("No active text editor found.");
      }
    }
  );
  context.subscriptions.push(generateWaveformCommand);

    // Add command to show semantic token debug output
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.tlverilog.showSemanticTokens', () => {
            vscode.window.showInformationMessage('Check the "TL-Verilog Semantic Tokens" output channel for debug info');
        })
    );
}

class tlverilogHoverProvider implements vscode.HoverProvider {

    private _excludedText: RegExp;

    constructor() {
        this._excludedText = RegExp(/\b(alias|always|always_comb|always_ff|always_latch|and|assert|assign|assume|automatic|before|begin|bind|bins|binsof|bit|break|buf|bufif0|bufif1|byte|case|casex|casez|cell|chandle|class|clocking|cmos|config|const|constraint|context|continue|cover|covergroup|coverpoint|cross|deassign|default|defparam|design|disable|dist|do|edge|else|end|endcase|endclass|endclocking|endconfig|endfunction|endgenerate|endgroup|endinterface|endmodule|endpackage|endprimitive|endprogram|endproperty|endspecify|endsequence|endtable|endtask|enum|event|expect|export|extends|extern|final|first_match|for|force|foreach|forever|fork|forkjoin|function|generate|genvar|highz0|highz1|if|iff|ifnone|ignore_bins|illegal_bins|import|incdir|include|initial|inout|input|inside|instance|int|integer|interface|intersect|join|join_any|join_none|large|liblist|library|local|localparam|logic|longint|macromodule|matches|medium|modport|module|nand|negedge|new|nmos|nor|noshowcancelled|not|notif0|notif1|null|or|output|package|packed|parameter|pmos|posedge|primitive|priority|program|property|protected|pull0|pull1|pulldown|pullup|pulsestyle_onevent|pulsestyle_ondetect|pure|rand|randc|randcase|randsequence|rcmos|real|realtime|ref|reg|release|repeat|return|rnmos|rpmos|rtran|rtranif0|rtranif1|scalared|sequence|shortint|shortreal|showcancelled|signed|small|solve|specify|specparam|static|string|strong0|strong1|struct|super|supply0|supply1|table|tagged|task|this|throughout|time|timeprecision|timeunit|tran|tranif0|tranif1|tri|tri0|tri1|triand|trior|trireg|type|typedef|union|unique|unsigned|use|uwire|var|vectored|virtual|void|wait|wait_order|wand|weak0|weak1|while|wildcard|wire|with|within|wor|xnor|xor)\b/);
    }

    public provideHover(
        document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken):
        vscode.Hover {
            // get word start and end
            let textRange = document.getWordRangeAtPosition(position);

            // hover word
            let targetText = document.getText(textRange);

            if (targetText.search(this._excludedText) !== -1) { // tlverilog keywords
                return;
            } else { // find declaration
                let declarationText = this._findDeclaration(document, position, targetText);
                if (declarationText !== undefined) {
                    return new vscode.Hover([ {language: 'tlverilog', value: declarationText.element}, declarationText.comment ]);
                } else {
                    return;
                }
            }
    }

    private _findDeclaration(document: vscode.TextDocument, position: vscode.Position, target: string): {element: string, comment: string} {
        // check target is valid variable name
        if (target.search(/[A-Za-z_][A-Za-z0-9_]*/g) === -1) {
            return;
        }

        let variableType = String.raw`\b(input|output|inout|reg|wire|logic|integer|bit|byte|shortint|int|longint|time|shortreal|real|double|realtime)\b\s+`;
        let variableTypeStart = '^' + variableType;
        let paraType = String.raw`^\b(parameter|localparam)\b\s+\b${target}\b`;

        let regexTarget = RegExp(String.raw`\b${target}\b`);
        let regexVariableType = RegExp(variableType, 'g');
        let regexVariableTypeStart = RegExp(variableTypeStart);
        let regexParaType = RegExp(paraType);

        // from previous line to first line
        for (let i = position.line-1; i >= 0; i--) {
            // text at current line
            let line = document.lineAt(i).text;
            let element = line.replace(/\/\/.*/, '').trim().replace(/\s+/g, ' ');
            let lastChar = element.charAt(element.length - 1);
            if (lastChar === ',' || lastChar === ';') { // remove last ',' or ';'
                element = element.substring(0, element.length - 1);
            }

            // find variable declaration type
            if (element.search(regexVariableTypeStart) !== -1) {
                // replace type to '', like input, output
                let subText = element.replace(regexVariableType, '').trim();

                // replace array to '', like [7:0]
                subText = subText.replace(/(\[.+?\])?/g, '').trim();
                if (subText.search(regexTarget) !== -1) {
                    let comment = getPrefixedComment(document, i);
                    if (comment)
                        return { element: element, comment: comment };
                    else {
                        comment = getSuffixedComment(document, i);
                        return { element: element, comment: comment };
                    }
                }
            }

            // find parameter declaration type
            if (element.search(regexParaType) !== -1) {
                let comment = getPrefixedComment(document, i);
                if(comment)
                    return { element: element, comment: comment };
                else{
                    comment = getSuffixedComment(document, i);
                    return { element: element, comment: comment };
                }
            }
        }
    }
}

function getPrefixedComment(document: vscode.TextDocument, lineNo: number) {
    let i = lineNo - 1;
    let buf = '';
    while (true) {
        let line = document.lineAt(i).text.trim();
        if (!line.startsWith('//'))
            break;
        buf = line.substring(3) + '\n' + buf;
        i--;
    }
    return buf;
}

function getSuffixedComment(document: vscode.TextDocument, lineNo: number) : string {
    // Spearate comment after the declaration
    let line = document.lineAt(lineNo).text;
    let idx = line.indexOf("//");
    if(idx !== -1)
        return line.substr(idx + 2).trim();
    else
        return undefined;
}

function getDirectories (srcpath: string): string[] {
    return fs.readdirSync(srcpath)
        .filter(file => fs.statSync(path.join(srcpath, file)).isDirectory());
}

function getFiles (srcpath: string): string[] {
    return fs.readdirSync(srcpath)
        .filter(file => fs.statSync(path.join(srcpath, file)).isFile());
}

function selectFile(currentDir?: string): Thenable<string> {
    currentDir = currentDir || vscode.workspace.rootPath;

    let dirs = getDirectories(currentDir);
    // if is subdirectory, add '../'
    if (currentDir !== vscode.workspace.rootPath) {
        dirs.unshift('..')
    }
    // all files ends with '.sv'
    let files = getFiles(currentDir)
        .filter(file => file.endsWith('.v') || file.endsWith('.sv'));

    // available quick pick items
    let items = dirs.concat(files);

    return vscode.window.showQuickPick(items)
        .then(selected => {
            if (!selected) {
                return;
            }

            // if is a directory
            let location = path.join(currentDir, selected);
            if (fs.statSync(location).isDirectory()) {
                return selectFile(location);
            }

            // return file path
            return location;
        });
}

function instantiatePort(ports: string[]): string {
    let port = ''
    // .NAME(NAME)
    for (let i = 0; i < ports.length; i++) {
        let element = ports[i];
        port += `\t.${element}(${element})`;

        if (i !== ports.length - 1) {
            port += ',';
        }
        port += '\n';
    }
    return port;
}

function instantiateModule(srcpath: string) {
    if (!srcpath || !fs.statSync(srcpath).isFile) {
        return;
    }

    // remove comment
    let content = fs.readFileSync(srcpath, 'utf8').replace(/\/\/.*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    if (content.indexOf('module') === -1) {
        return;
    }
    // module 2001 style
    let moduleIO = content.substring(content.indexOf('module'), content.indexOf(';'));
    let moduleName = moduleIO.match(/module\s+\b([A-Za-z_][A-Za-z0-9_]*)\b/)[1];
    let parametersName = [];
    let portsName = [];
    let lines = moduleIO.split('\n');

    // find all parameters and ports
    lines.forEach(line => {
        line = line.trim();
        let matched = line.match(/parameter\s+\b([A-Za-z_][A-Za-z0-9_]*)\b/);
        if (matched !== null) {
            parametersName.push(matched[1]);
        }

        if (line.search(/^\b(input|output|inout)\b/) !== -1) {
            let variables = line.replace(/\b(input|output|inout|reg|wire|logic|integer|bit|byte|shortint|int|longint|time|shortreal|real|double|realtime)\b/g, '')
                .replace(/(\[.+?\])?/g, '').replace(/\s+/g, '').split(',').forEach(variable => {
                if (variable) {
                    portsName.push(variable);
                }
            });
        }
    });

    if (portsName.length === 0) {
        return;
    }

    let prefix =
        vscode.workspace
        .getConfiguration("tlverilog")['instancePrefix'];

    let paramString = ``
    if (parametersName.length > 0) {
        paramString = `\n#(\n${instantiatePort(parametersName)})\n`
    }

    return new vscode.SnippetString()
        .appendText(moduleName + " ")
        .appendText(paramString)
        .appendPlaceholder(prefix)
        .appendPlaceholder(`${moduleName}(\n`)
        .appendText(instantiatePort(portsName))
        .appendText(');\n');
}

function instantiateModuleInteract() {
    let filePath = path.dirname(vscode.window.activeTextEditor.document.fileName);
    selectFile(filePath).then(srcpath => {
        let inst = instantiateModule(srcpath);
        vscode.window.activeTextEditor.insertSnippet(inst);
    });
}

async function compileTLVerilogWithSandPiper(
  tlvCode: string,
  inputFilePath: string
): Promise<void> {
  const filename = path.basename(inputFilePath);
  console.log(filename);
  const externSettings =
    vscode.workspace.getConfiguration("tlverilog").get("formattingSettings") ||
    [];
  const args = `-i ${filename} -o ${filename.replace(
    ".tlv",
    ".sv"
    //@ts-ignore
  )} --m4out out/m4out ${externSettings.join(" ")} --iArgs`;

  try {
    const response = await axios.post(
      "https://faas.makerchip.com/function/sandpiper-faas",
      JSON.stringify({
        args,
        responseType: "json",
        sv_url_inc: true,
        files: {
          [filename]: tlvCode,
        },
      }),
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    if (response.status !== 200) {
      throw new Error(
        `SandPiper SaaS request failed with status ${response.status}`
      );
    }
    const data = response.data;
    const outputKey = Object.keys(data).find(
      (key) => key.startsWith("out/") && key.endsWith(".sv")
    );
    const genKey = Object.keys(data).find(
      (key) => key.startsWith("out/") && key.endsWith("_gen.sv")
    );

    if (outputKey && genKey) {
      const verilog = (data[outputKey] as string)
        .replace(
          `\`include "${path.basename(genKey)}"`,
          "// gen included here\n" + data[genKey]
        )
        .split("\n")
        .filter((line) => !line.startsWith('`include "sp_default.vh"'))
        .join("\n");
      const outputDirectory = path.dirname(inputFilePath);
      const outputFilePath = path.join(
        outputDirectory,
        path.basename(outputKey)
      );
      const genFilePath = path.join(outputDirectory, path.basename(genKey));

      fs.writeFileSync(outputFilePath, verilog);
      fs.writeFileSync(genFilePath, data[genKey]);

      vscode.window.showInformationMessage(
        `Generated Verilog code saved to ${outputFilePath} and ${genFilePath}`
      );
    } else {
      console.error("Output files not found in response:", data); 
      throw new Error(
        "SandPiper SaaS compilation failed: Output files not found in response."
      );
    }
  } catch (error) {
    let errorMessage = "SandPiper SaaS compilation failed: ";
    if (axios.isAxiosError(error)) {
      errorMessage += error.message;
    } else {
      errorMessage += error;
    }
    vscode.window.showErrorMessage(errorMessage);
    throw new Error(errorMessage);
  }
}


async function generateSvgFile(
  tlvCode: string,
  inputFilePath: string
): Promise<string> {
  const filename = path.basename(inputFilePath);
  const externSettings =
    vscode.workspace.getConfiguration("tlverilog").get("formattingSettings") ||
    [];
  //@ts-ignore
  const args = `-i ${filename} --graphTrans --svg ${externSettings.join(
    " "
  )} --iArgs`;

  try {
    const response = await axios.post(
      "https://faas.makerchip.com/function/sandpiper-faas",
      JSON.stringify({
        args,
        responseType: "json",
        sv_url_inc: true,
        files: {
          [filename]: tlvCode,
        },
      }),
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    if (response.status !== 200) {
      throw new Error(
        `SandPiper SaaS request failed with status ${response.status}`
      );
    }
    const data = response.data;
    const svgOutputKeyM4 = `out/${filename.replace('.tlv', '.m4out_graph.svg')}`;
    const svgOutputKeyM5 = `out/${filename.replace('.tlv', '.m5out_graph.svg')}`;
    const svgOutputKey =  data[svgOutputKeyM5] ? svgOutputKeyM5 : svgOutputKeyM4;
    if (data[svgOutputKey]) {
      const svgContent = data[svgOutputKey];
      const outputDirectory = path.dirname(inputFilePath);
      const svgFilePath = path.join(
        outputDirectory,
        `${path.basename(filename, ".tlv")}_diagram.svg`
      );
      fs.writeFileSync(svgFilePath, svgContent);
      return svgFilePath;
    } else {
      throw new Error(
        "SandPiper SaaS compilation failed: No SVG output generated."
      );
    }
  } catch (error) {
    let errorMessage = "SandPiper SaaS compilation failed: ";
    if (axios.isAxiosError(error)) {
      errorMessage += error.message;
    } else {
      errorMessage += error;
    }
    vscode.window.showErrorMessage(errorMessage);
    throw new Error(errorMessage);
  }
}

function showSvgInWebview(svgFilePath: string) {
  const panel = vscode.window.createWebviewPanel(
    "svgViewer",
    "TL-Verilog SVG Viewer",
    vscode.ViewColumn.Two,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  const svg = fs.readFileSync(svgFilePath, "utf8");
  const webviewContent = `
       <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Sandpiper Diagram Viewer</title>
        <style>
            body { 
                margin: 0; 
                padding: 0;
                height: 100vh;
                display: flex;
                flex-direction: column;
                background-color: #f0f0f0;
            }
            .controls-container {
                position: fixed;
                top: 10px;
                right: 10px;
                z-index: 1000;
            }
            .zoom-controls {
                display: flex;
                flex-direction: column;
                background-color: white;
                border-radius: 4px;
                box-shadow: 0 2px 5px rgba(0,0,0,0.1);
            }
            .zoom-button {
                padding: 5px 10px;
                font-size: 18px;
                cursor: pointer;
                border: none;
                background-color: transparent;
            }
            .zoom-button:hover {
                background-color: #f0f0f0;
            }
            .zoom-reset {
                border-top: 1px solid #ccc;
                font-size: 14px;
            }
            .svg-container {
                flex: 1;
                display: flex;
                justify-content: center;
                align-items: center;
                overflow: hidden;
            }
            svg { 
                max-width: 100%; 
                max-height: 100%; 
                border: 1px solid #ccc; 
                background-color: white;
            }
        </style>
    </head>
    <body>
        <div class="controls-container">
            <div class="zoom-controls">
                <button class="zoom-button" onclick="zoomIn()">+</button>
                <button class="zoom-button" onclick="zoomOut()">-</button>
                <button class="zoom-button zoom-reset" onclick="resetZoom()">RESET</button>
            </div>
        </div>
        <div class="svg-container" id="svg-container">
            ${svg}
        </div>
    
        <script>
        //@ts-nocheck
        let currentZoom = 1;
        const svgContainer = document.getElementById('svg-container');
        const svg = svgContainer.querySelector('svg');
    
        function zoomIn() {
            currentZoom *= 1.2;
            updateZoom();
        }
    
        function zoomOut() {
            currentZoom /= 1.2;
            updateZoom();
        }
    
        function resetZoom() {
            currentZoom = 1;
            updateZoom();
        }
    
        function updateZoom() {
            svg.style.transform = \`scale(\${currentZoom})\`;
        }
        </script>
    </body>
    </html>
    ` as const;

  panel.webview.html = webviewContent;
}


async function generateNavTlvHtml(
  tlvCode: string,
  inputFilePath: string
): Promise<string> {
  const externSettings =
    vscode.workspace.getConfiguration("tlverilog").get("formattingSettings") ||
    [];
  const filename = path.basename(inputFilePath);
  //@ts-ignore
  const args = `-i ${filename} -o gene.sv --dhtml ${externSettings.join(
    " "
  )} --iArgs`;

  try {
    const response = await axios.post(
      "https://faas.makerchip.com/function/sandpiper-faas",
      JSON.stringify({
        args,
        responseType: "json",
        sv_url_inc: true,
        files: {
          [filename]: tlvCode,
        },
      }),
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    if (response.status !== 200) {
      throw new Error(
        `SandPiper SaaS request failed with status ${response.status}`
      );
    }

    const data = response.data;
    console.log(data);
    const htmlOutputKeyM4 = `out/${filename.replace('.tlv', '.m4out.html')}`;
    const htmlOutputKeyM5 = `out/${filename.replace('.tlv', '.m5out.html')}`;

    // const outputKey = Object.keys(data).find(
    //   (key) => key.startsWith("out/") && key.endsWith(".html")
    // );
    const htmlOutputKey =  data[htmlOutputKeyM5] ? htmlOutputKeyM5 : htmlOutputKeyM4;
    if (data[htmlOutputKey]) {
      const htmlContent = data[htmlOutputKey];
      return htmlContent;
    } else {
      throw new Error(
        "SandPiper SaaS compilation failed: No HTML output generated."
      );
    }
  } catch (error) {
    let errorMessage = "SandPiper SaaS compilation failed: ";
    if (axios.isAxiosError(error)) {
      errorMessage += error.message;
    } else {
      errorMessage += error;
    }
    vscode.window.showErrorMessage(errorMessage);
    throw new Error(errorMessage);
  }
}

function showNavTlvInWebview(navTlvHtml: string) {
  const panel = vscode.window.createWebviewPanel(
    "navTlvViewer",
    "Nav TLV Viewer",
    vscode.ViewColumn.Two,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  const modifiedHtml = `
          <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Nav TLV Viewer</title>
            <style>
                body { 
                    font-family: Arial, sans-serif; 
                    background-color: white;
                    margin: 0;
                    padding: 20px;
                }
                .nav-tlv-content { 
                    white-space: pre; 
                    font-family: monospace; 
                    background-color: white;
                }
            </style>
        </head>
        <body>
            <div class="nav-tlv-content">${navTlvHtml}</div>
            <script>
                // You can add any necessary JavaScript here
            </script>
        </body>
        </html>
    `;

  panel.webview.html = modifiedHtml;
}

export function deactivate(
  sandpiperButton: SandPiperButton,
  svgButton: SvgButton,
  navTlvButton: NavTlvButton,
  waveformButton: WaveformButton
) {
  if (sandpiperButton) {
    sandpiperButton.hide();
    sandpiperButton.dispose();
  }

  if (svgButton) {
    svgButton.hide();
    svgButton.dispose();
  }
  if (navTlvButton) {
    navTlvButton.hide();
    navTlvButton.dispose();
  }
  if (waveformButton) {
    waveformButton.hide();
    waveformButton.dispose();
  }
}


async function launchGTKWave(vcdFilePath: string) {
  const command = `gtkwave "${vcdFilePath}"`;
  
  try {
    await exec(command);
  } catch (error) {
    throw new Error(`Failed to launch GTKWave: ${error.message}`);
  }
}

async function checkGTKWaveInstallation() {
  try {
    await exec('gtkwave --version');
    return true;
  } catch (error) {
    return false;
  }
}

async function setupSimulationFiles(outputDirectory: string) {
  const makerchipSvContent = `
module makerchip(input logic clk, input logic reset_async, output logic passed, output logic failed);
logic reset;
logic [31:0] cyc_cnt;
always_ff @(posedge clk) begin
   reset <= reset_async;
   cyc_cnt <= reset ? 32'b1 : cyc_cnt + 32'b1;
end
top top(.*);
endmodule
`;

  const simMainCppContent = `
#include <verilated.h>
#include <string.h>
#include "Vmakerchip.h"
#if VM_TRACE
# include <verilated_vcd_c.h>
#endif
Vmakerchip *makerchip;
vluint64_t sim_time = 0;
double sc_time_stamp () {
    return (double)sim_time;
    }
int main(int argc, char **argv, char **env) {
    makerchip = new Vmakerchip;
    Verilated::commandArgs(argc, argv);
    Verilated::debug(0);
#if VM_TRACE
    Verilated::traceEverOn(true);
    VerilatedVcdC* tfp = new VerilatedVcdC;
    makerchip->trace (tfp, 99);
    tfp->open ("vlt_dump.vcd");
#endif
    int RESET_DURATION = 4;
    makerchip->clk = 0;
    makerchip->reset_async = 1;
    makerchip->passed = 0;
    makerchip->failed = 0;
    while (sim_time < 400000 &&
           (makerchip->clk ? !makerchip->passed && !makerchip->failed
                           : sim_time < 1200 || (makerchip->passed && makerchip->failed)
           ) && !Verilated::gotFinish()) {
        makerchip->clk = !makerchip->clk;
        if (!makerchip->clk) {
          if (sim_time >= RESET_DURATION * 2) {
            makerchip->reset_async = 0;
          }
        }
        makerchip->eval();
#if VM_TRACE
        if (tfp) tfp->dump(sim_time);
#endif
        sim_time++;
    }
    makerchip->final();
#if VM_TRACE
    if (tfp) tfp->close();
#endif
    if (makerchip->failed) {
        printf("Simulation FAILED!!!\\n");
    } else if (makerchip->passed) {
        printf("Simulation PASSED!!!\\n");
    } else {
        printf("Simulation reached max cycles.\\n");
    }
    exit(0L);
}
  `;
  const pseudoRandContent = `
module pseudo_rand #(parameter WIDTH=257) (
  input wire clk,
  input wire reset,
  output reg [WIDTH-1:0] rand_out
);
  always @(posedge clk or posedge reset) begin
    if (reset)
      rand_out <= {WIDTH{1'b0}};
    else
      rand_out <= {rand_out[WIDTH-2:0], rand_out[WIDTH-1] ^ rand_out[WIDTH-2]};
  end
endmodule
`;


  fs.writeFileSync(
    path.join(outputDirectory, "makerchip.sv"),
    makerchipSvContent
  );
  fs.writeFileSync(
    path.join(outputDirectory, "sim_main.cpp"),
    simMainCppContent
  );
  fs.writeFileSync(
    path.join(outputDirectory, "pseudo_rand.sv"),
    pseudoRandContent
  );
}

async function compileWithVerilator(
  verilogFilePath: string,
  outputDirectory: string
) {
  const command = `verilator -Wall --trace -cc ${path.basename(verilogFilePath)} pseudo_rand.sv makerchip.sv --exe sim_main.cpp --top-module makerchip -I. -Wno-DECLFILENAME -Wno-UNUSEDSIGNAL -Wno-SYNCASYNCNET`;

  try {
    const { stdout, stderr } = await exec(command, { cwd: outputDirectory });
    if (stderr) {
      throw new Error(stderr);
    }
    vscode.window.showInformationMessage("Verilator compilation successful");
  } catch (error) {
    throw new Error(`Verilator compilation failed: ${error.message}`);
  }
}

async function runSimulation(outputDirectory: string) {
  const command = `make -C obj_dir -f Vmakerchip.mk Vmakerchip && ./obj_dir/Vmakerchip`;
  try {
    const { stdout, stderr } = await exec(command, { cwd: outputDirectory });
    console.log(`Simulation stdout: ${stdout}`);
    console.log(`Simulation stderr: ${stderr}`);
    if (stderr && !stderr.includes("Warning")) {
      throw new Error(stderr);
    }
    vscode.window.showInformationMessage("Simulation completed successfully");
  } catch (error) {
    throw new Error(`Simulation failed: ${error.message}`);
  }
}
