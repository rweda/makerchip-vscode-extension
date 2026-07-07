// Experimental feature: run a Verilator simulation and open the waveform in GTKWave.
//
// Node-only: shells out to `verilator`, `make`, and `gtkwave`. Requires those
// tools to be installed locally. Not part of the web build.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import * as util from 'util';
import { createTlvStatusButton } from './statusBar';

const exec = util.promisify(child_process.exec);

export function registerWaveform(context: vscode.ExtensionContext): void {
  createTlvStatusButton(context, {
    text: '$(pulse) Waveform',
    tooltip: 'Generate and view waveform',
    command: 'extension.runVerilator',
    priority: 2,
    alwaysVisible: true
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('extension.runVerilator', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('No active text editor found.');
        return;
      }
      const document = editor.document;
      if (document.languageId === 'systemverilog' || document.languageId === 'verilog') {
        try {
          await generateAndViewWaveform(document.uri.fsPath);
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to generate waveform: ${error.message}`);
        }
      } else {
        vscode.window.showInformationMessage('The active file is not a SystemVerilog or Verilog file.');
      }
    })
  );
}

async function generateAndViewWaveform(filePath: string) {
  const outputDirectory = path.dirname(filePath);
  const vcdFilePath = path.join(outputDirectory, `vlt_dump.vcd`);

  try {
    await setupSimulationFiles(outputDirectory);
    await compileWithVerilator(filePath, outputDirectory);
    await runSimulation(outputDirectory);

    const isGTKWaveInstalled = await checkGTKWaveInstallation();
    if (!isGTKWaveInstalled) {
      vscode.window.showErrorMessage(
        'GTKWave is not installed. Please install GTKWave to view waveforms.'
      );
      return;
    }

    await launchGTKWave(vcdFilePath);

    vscode.window.showInformationMessage(`Waveform opened in GTKWave: ${vcdFilePath}`);
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to generate waveform: ${error.message}`);
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

  fs.writeFileSync(path.join(outputDirectory, 'makerchip.sv'), makerchipSvContent);
  fs.writeFileSync(path.join(outputDirectory, 'sim_main.cpp'), simMainCppContent);
  fs.writeFileSync(path.join(outputDirectory, 'pseudo_rand.sv'), pseudoRandContent);
}

async function compileWithVerilator(verilogFilePath: string, outputDirectory: string) {
  const command = `verilator -Wall --trace -cc ${path.basename(verilogFilePath)} pseudo_rand.sv makerchip.sv --exe sim_main.cpp --top-module makerchip -I. -Wno-DECLFILENAME -Wno-UNUSEDSIGNAL -Wno-SYNCASYNCNET`;

  try {
    const { stdout, stderr } = await exec(command, { cwd: outputDirectory });
    if (stderr) {
      throw new Error(stderr);
    }
    vscode.window.showInformationMessage('Verilator compilation successful');
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
    if (stderr && !stderr.includes('Warning')) {
      throw new Error(stderr);
    }
    vscode.window.showInformationMessage('Simulation completed successfully');
  } catch (error) {
    throw new Error(`Simulation failed: ${error.message}`);
  }
}
