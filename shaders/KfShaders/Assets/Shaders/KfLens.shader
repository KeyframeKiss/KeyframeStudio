// Lens: distortion (barrel / pincushion, refitted to the frame), chromatic aberration (colour fringes towards the
// edges, spread across the spectrum), vignette (a lens's natural falloff and/or a shaped one), film grain.
Shader "Hidden/KeyframeStudio/Lens"
{
    Properties
    {
        _MainTex ("", 2D) = "white" {}
    }
    SubShader
    {
        ZTest Always Cull Off ZWrite Off
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.0
            #include "KfCommon.cginc"

            float4 _KfLens;     // x chromatic aberration (0..1), y vignette intensity (0..1), z vignette smoothness (0..1), w vignette roundness (0..1)
            float4 _KfVigColor; // rgb
            float4 _KfGrain;    // x amount (0..1), y size (1..3), z time seed, w render pixels per screen pixel
            float4 _KfLens2;    // x distortion (+ barrel, - pincushion), y fit scale, z natural falloff (0..1), w tan(half the vertical field of view)

            float Hash(float2 p) { return frac(sin(dot(p, float2(12.9898, 78.233))) * 43758.5453); }

            fixed4 frag(v2f i) : SV_Target
            {
                float aspect = _ScreenParams.x / _ScreenParams.y;
                float2 uv = i.uv;
                if (_KfLens2.x != 0)
                {
                    float2 d = (uv - 0.5) * float2(aspect, 1);
                    d *= (1 + _KfLens2.x * dot(d, d)) / _KfLens2.y;
                    uv = d / float2(aspect, 1) + 0.5;
                }
                float2 fromCenter = uv - 0.5;
                fixed4 src = tex2D(_MainTex, uv);
                float3 c = src.rgb;

                if (_KfLens.x > 0)
                {
                    // seven samples along the fringe, each weighted towards red, green or blue like a spectrum
                    float2 off = fromCenter * dot(fromCenter, fromCenter) * _KfLens.x * 0.06;
                    float3 acc = 0;
                    float3 wsum = 0;
                    for (int k = 0; k < 7; k++)
                    {
                        float t = k / 3.0 - 1;
                        float3 w = saturate(1 - abs(t - float3(-0.66, 0, 0.66)) * 1.5);
                        acc += tex2D(_MainTex, uv + off * t).rgb * w;
                        wsum += w;
                    }
                    c = acc / max(wsum, 0.001);
                }

                if (_KfLens2.z > 0)
                {
                    // a real lens is darker towards the edges (cos^4 of the angle off the axis): wider lenses more
                    float2 v = (i.uv - 0.5) * 2 * float2(aspect, 1) * _KfLens2.w;
                    float c2 = 1 / (1 + dot(v, v));
                    c *= lerp(1, c2 * c2, _KfLens2.z);
                }

                if (_KfLens.y > 0)
                {
                    float aspect = _ScreenParams.x / _ScreenParams.y;
                    float2 v = fromCenter * float2(lerp(1, aspect, _KfLens.w), 1) * 2;
                    float r = length(v);
                    float soft = max(0.01, _KfLens.z);
                    float mask = smoothstep(1.15 - _KfLens.y * 0.75, 1.15 - _KfLens.y * 0.75 + soft, r);
                    c = lerp(c, _KfVigColor.rgb, mask * saturate(_KfLens.y * 1.5));
                }

                if (_KfGrain.x > 0)
                {
                    float2 g = floor(uv * _ScreenParams.xy / max(1, _KfGrain.y * max(1, _KfGrain.w)));
                    float n = Hash(g + _KfGrain.z) - 0.5;
                    float l = Luma(c);
                    // strongest in the midtones, like film
                    c += n * _KfGrain.x * 0.25 * (1 - abs(l * 2 - 1) * 0.6);
                }
                return fixed4(saturate(c), src.a);
            }
            ENDCG
        }
    }
    Fallback Off
}
