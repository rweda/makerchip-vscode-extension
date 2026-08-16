\m5_TLV_version 1d: tl-x.org
\m5
   // ===================================
   // A minimal TL-Verilog scratch design
   // ===================================
\SV
   m5_makerchip_module
\TLV
   $reset = *reset;
   $count[7:0] = $reset ? 8'b0 : >>1$count + 8'b1;

   *passed = *cyc_cnt > 40;
   *failed = 1'b0;
\SV
   endmodule
